/** #3429 (4669 blind): a post-commit effect that fails is REPORTED, never raised, once the retirement has committed. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));
// Fails the node-written announcement synchronously, once armed: the effect writeNodeCore runs after the commit.
const arm = vi.hoisted(() => ({ on: false }));
vi.mock('../../../lib/events/nodeWritten.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/events/nodeWritten.js')>();
  return { ...actual, publishNodeWritten: (...a: Parameters<typeof actual.publishNodeWritten>) => {
    if (arm.on) throw new Error('announcement failed after commit');
    return actual.publishNodeWritten(...a);
  } };
});

// A rejecting edge mirror once armed: the async post-commit effect, whose promise rejection the door's guard must catch.
const mirrorArm = vi.hoisted(() => ({ on: false }));
vi.mock('../../../integrations/github/mirrorEdgeSource.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../integrations/github/mirrorEdgeSource.js')>();
  return { ...actual, mirrorEdgeSourceAfterCommit: (...a: Parameters<typeof actual.mirrorEdgeSourceAfterCommit>) =>
    mirrorArm.on ? Promise.reject(new Error('edge mirror failed after commit')) : actual.mirrorEdgeSourceAfterCommit(...a) };
});

let admin: { id: string };
let memoryId: string;
const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const spec = async (loc: string) => (await resolvers.Mutation.createSpecNode(null, { input: {
  memoryRef: memoryId, loc, name: loc, role: 'spec', content: '# T\n\nBody.', abstract: `About ${loc}.`, tags: ['spec'],
} } as never, ctx())) as { id: string };

beforeEach(async () => {
  arm.on = false;
  mirrorArm.on = false;
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Post Org', urn: 'post-org.example' } });
  admin = await db.user.create({ data: { githubId: 342921, githubUsername: 'post-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'post-specs', draftCorpus: true }, ctx())).id;
});

describe('#3429 failures after the commit', () => {
  it('a throwing announcement is logged and the caller still gets the committed retirement', async () => {
    const x = await spec('p:x'); const y = await spec('p:y');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    arm.on = true;
    try {
      const out = await resolvers.Mutation.retireSpec(null, { input: {
        ref: x.id, form: 'SUPERSEDE', successorRef: y.id, expectedRevision: (await db.node.findUniqueOrThrow({ where: { id: x.id } })).revSeq,
      } } as never, ctx()) as { node: { tags: string[] }; successorEdge: unknown };
      expect(out.node.tags).toContain('superseded');
      expect(out.successorEdge).not.toBeNull();
      // The effect-specific report: this message AND the injected error, not any '[retireSpec] post-commit' line.
      expect(logged.mock.calls.some((c) => String(c[0]).includes('[retireSpec] post-commit effect failed after the retirement committed:')
        && c[1] instanceof Error && c[1].message === 'announcement failed after commit')).toBe(true);
    } finally { arm.on = false; logged.mockRestore(); }
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).tags).toContain('superseded');
    expect(await db.edge.count({ where: { sourceId: x.id, name: 'superseded-by', deletedAt: null } })).toBe(1);
  });

  it('a REJECTING edge mirror (an async effect) is logged with its own message and the caller still gets the committed retirement', async () => {
    const x = await spec('p:mx'); const y = await spec('p:my');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mirrorArm.on = true;
    try {
      const out = await resolvers.Mutation.retireSpec(null, { input: {
        ref: x.id, form: 'SUPERSEDE', successorRef: y.id, expectedRevision: (await db.node.findUniqueOrThrow({ where: { id: x.id } })).revSeq,
      } } as never, ctx()) as { node: { tags: string[] }; successorEdge: unknown };
      expect(out.node.tags).toContain('superseded');
      expect(out.successorEdge).not.toBeNull();
      expect(logged.mock.calls.some((c) => String(c[0]).includes('[retireSpec] post-commit edge mirror failed after the retirement committed:')
        && c[1] instanceof Error && c[1].message === 'edge mirror failed after commit')).toBe(true);
      // the synchronous-effect report is a different message: this case must not be satisfied by it
      expect(logged.mock.calls.some((c) => String(c[0]).includes('post-commit effect failed'))).toBe(false);
    } finally { mirrorArm.on = false; logged.mockRestore(); }
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).tags).toContain('superseded');
    expect(await db.edge.count({ where: { sourceId: x.id, name: 'superseded-by', deletedAt: null } })).toBe(1);
  });
});

