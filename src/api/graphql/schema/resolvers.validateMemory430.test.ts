/**
 * #430 (first slice) — `validateMemory` / `hadron_validate` surface the Git-mirror obligations a failed attempt left.
 *
 * The finding carries counts, the FIXED error class and a node loc only (never exception text), and it sits behind the
 * existing node-content gate: a reader of one memory sees that memory's rows, a caller who cannot read it gets the
 * not-found answer, and an encrypted memory (never mirrored) shows none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { formatFindingLine } from '../../../lib/memoryValidation.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let org: { id: string; urn: string };
let member: { id: string };
let stranger: { id: string };
let mem: { id: string; urn: string };
let other: { id: string; urn: string };

const makeMemory = (slug: string, extra: Record<string, unknown> = {}) => db.memory.create({
  data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION', ...extra },
});
const obligation = (memoryId: string, nodeId: string, over: Record<string, unknown> = {}) => db.gitMirrorObligation.create({
  data: { memoryId, nodeId, kind: 'WRITE', removeLoc: '', state: 'FAILED', errorClass: 'PUSH_FAILED', attemptSeq: 1n, ...over } as never,
});
const validate = (memoryRef: string, c: Context = ctx(member.id)) => Q.validateMemory(null, { memoryRef }, c);
const mirrorFindings = (r: { findings: Array<{ kind: string; detail: string }> }) => r.findings.filter((f) => f.kind === 'GIT_MIRROR_FAILED');

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'vm430', urn: `vm430-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 43001, githubUsername: 'vm430-member' } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 43002, githubUsername: 'vm430-stranger' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  mem = await makeMemory('mem');
  other = await makeMemory('other');
});

describe('validateMemory — Git-mirror obligations (#430)', () => {
  it('a WRITE row is a finding on that node: its loc, the fixed class, no free text', async () => {
    const n = await createDbNode(db, { loc: 'topic', memoryId: mem.id, name: 'T', content: 'x' });
    await obligation(mem.id, n.id);
    const r = await validate(mem.id);
    expect(mirrorFindings(r)).toEqual([expect.objectContaining({
      kind: 'GIT_MIRROR_FAILED', nodeId: n.id, nodeLoc: 'topic', detail: expect.stringContaining('PUSH_FAILED'),
    })]);
    expect(r.ok).toBe(false);
    expect(r.totalFindings).toBe(1);
  });

  it('a REMOVE row is a finding at the path it still owes, even though the node has left it', async () => {
    const n = await createDbNode(db, { loc: 'new', memoryId: mem.id, name: 'N', content: 'x' });
    await obligation(mem.id, n.id, { kind: 'REMOVE', removeLoc: 'old:path', errorClass: 'TREE_WRITE' });
    const found = mirrorFindings(await validate(mem.id));
    expect(found).toEqual([expect.objectContaining({ nodeId: n.id, nodeLoc: 'old:path', detail: expect.stringContaining('TREE_WRITE') })]);
  });

  it('a NOT_CLONED row reads as such', async () => {
    const n = await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'x' });
    await obligation(mem.id, n.id, { state: 'NOT_CLONED', errorClass: 'NOT_CLONED' });
    expect(mirrorFindings(await validate(mem.id))[0].detail).toContain('NOT_CLONED');
  });

  it('a WRITE row for a node that is gone is not reported (no live node to act on, cf. #884)', async () => {
    const n = await createDbNode(db, { loc: 'gone', memoryId: mem.id, name: 'G', content: 'x' });
    await obligation(mem.id, n.id);
    await db.node.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
    expect(mirrorFindings(await validate(mem.id))).toEqual([]);
  });

  it("another memory's rows never appear, and a caller who cannot read the memory gets the not-found answer", async () => {
    const mine = await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'x' });
    const theirs = await createDbNode(db, { loc: 'b', memoryId: other.id, name: 'B', content: 'x' });
    await obligation(mem.id, mine.id);
    await obligation(other.id, theirs.id);
    expect(mirrorFindings(await validate(mem.id)).map((f: any) => f.nodeId)).toEqual([mine.id]);
    const absent = generateId();
    const missing = await validate(absent).then(() => null, (e: any) => e);
    const denied = await validate(mem.id, ctx(stranger.id)).then(() => null, (e: any) => e);
    expect(missing?.message).toMatch(/^MEMORY_NOT_FOUND/);
    // Byte-identical apart from the ref each names: denied is the SAME answer as absent, never a different one.
    expect(denied?.message.replace(mem.id, '<ref>')).toBe(missing?.message.replace(absent, '<ref>'));
    expect(denied?.extensions?.code).toBe(missing?.extensions?.code);
  });

  it('an encrypted memory is never mirrored, so a leftover row shows nothing', async () => {
    const enc = await makeMemory('enc', { isEncrypted: true });
    const n = await createDbNode(db, { loc: 'a', memoryId: enc.id, name: 'A', content: 'x' });
    await obligation(enc.id, n.id);
    expect(mirrorFindings(await validate(enc.id))).toEqual([]);
  });

  it('the MCP line is `[git-mirror-failed] <urn> — <detail>`', () => {
    const line = formatFindingLine({ kind: 'GIT_MIRROR_FAILED', nodeId: 'n', nodeLoc: 'a', detail: 'Git mirror write did not land (PUSH_FAILED)' }, 'urn:x');
    expect(line).toBe('[git-mirror-failed] urn:x — Git mirror write did not land (PUSH_FAILED)');
  });
});
