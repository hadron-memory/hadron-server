/** #3429: `hadron_retire_spec` delegates to the one door, so it refuses and writes exactly what GraphQL `retireSpec` does. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));

let userId: string;
let mem: { id: string };
let other: { id: string };
const gql = (): Context => ({ db, userId, roles: [] });
const mcp = () => createTestableMcpServer({ userId, roles: [], clientId: `user:${userId}` });
const spec = async (loc: string, memoryId = mem.id) => (await resolvers.Mutation.createSpecNode(null, { input: {
  memoryId, loc, name: `Spec ${loc}`, content: `# T ${loc}\n\nBody.`, abstract: `About ${loc}.`, tags: ['spec'],
} } as never, gql())) as { id: string };
const revision = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).revSeq;
const state = async (id: string) => JSON.stringify({
  n: await db.node.findUniqueOrThrow({ where: { id } }), e: await db.edge.findMany({ where: { sourceId: id } }), r: await db.nodeRevision.count({ where: { nodeId: id } }),
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Mcp Retire', urn: 'mcp-retire.example' } });
  const user = await db.user.create({ data: { githubId: 342903, githubUsername: 'mcp-retire', roles: [] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  mem = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'mcp-specs', draftCorpus: true }, gql());
  other = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'mcp-other', draftCorpus: true }, gql());
});

describe('hadron_retire_spec (#3429)', () => {
  it('rescinds: the same text and one revision as the GraphQL door', async () => {
    const x = await spec('m:010:01'); const y = await spec('m:010:02');
    const a = await mcp().callToolText('hadron_retire_spec', { ref: x.id, form: 'rescind', expectedRevision: await revision(x.id), reason: 'gone', summary: 'old' });
    expect(a).toContain('spec retired (rescind)');
    const b = await resolvers.Mutation.retireSpec(null, { input: { ref: y.id, form: 'RESCIND', expectedRevision: await revision(y.id), reason: 'gone', summary: 'old' } } as never, gql()) as { node: { abstract: string; content: string } };
    const ax = await db.node.findUniqueOrThrow({ where: { id: x.id } });
    expect(ax.abstract?.replace(/\d{4}-\d\d-\d\d/, 'D')).toBe(b.node.abstract.replace(/\d{4}-\d\d-\d\d/, 'D'));
    expect((ax.content ?? '').replace(/\d{4}-\d\d-\d\d/, 'D').replace('T m:010:01', 'T m:010:02')).toBe(b.node.content.replace(/\d{4}-\d\d-\d\d/, 'D'));
  });

  it('supersedes: one superseded-by edge, in the same transaction', async () => {
    const x = await spec('m:020:01'); const y = await spec('m:020:02');
    const text = await mcp().callToolText('hadron_retire_spec', { ref: x.id, form: 'supersede', successorRef: y.id, expectedRevision: await revision(x.id) });
    expect(text).toContain('superseded-by edge:');
    expect(await db.edge.count({ where: { sourceId: x.id, targetId: y.id, name: 'superseded-by', deletedAt: null } })).toBe(1);
  });

  it('refuses the same cases, writing nothing, with the typed code in the text', async () => {
    const x = await spec('m:030:01'); const live = await spec('m:030:02'); const foreign = await spec('m:030:03', other.id);
    await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: live.id, targetId: x.id, loc: 'k1', name: 'superseded-by' } });
    const before = await state(x.id);
    const call = async (input: Record<string, unknown>) => mcp().callToolText('hadron_retire_spec', { ref: x.id, expectedRevision: await revision(x.id), ...input });
    expect(await call({ form: 'rescind', expectedRevision: 999, reason: 'r', summary: 's' })).toContain('[node_write_conflict]');
    expect(await call({ form: 'supersede', successorRef: x.id })).toContain('[node_write_conflict]');
    expect(await call({ form: 'supersede', successorRef: foreign.id })).toContain('[node_write_conflict]');
    expect(await call({ form: 'supersede', successorRef: live.id })).toContain('[node_write_conflict]');
    expect(await call({ form: 'supersede', successorRef: generateId() })).toContain('[node_not_found]');
    expect(await call({ form: 'rescind', reason: ' ', summary: 's' })).toContain('[bad_user_input]');
    expect(await state(x.id)).toBe(before);
    // A spec that already has a successor link is refused through MCP exactly as through GraphQL.
    expect(await mcp().callToolText('hadron_retire_spec', { ref: live.id, form: 'rescind', expectedRevision: await revision(live.id), reason: 'r', summary: 's' })).toContain('[node_write_conflict]');
  });

  it('an over-cap composed abstract is the typed refusal text, not an opaque internal error (#4669 QA P2)', async () => {
    const x = await spec('m:040:01');
    const text = await mcp().callToolText('hadron_retire_spec', { ref: x.id, form: 'rescind', expectedRevision: await revision(x.id), reason: 'r', summary: 's'.repeat(1990) });
    expect(text).toContain('Abstract exceeds 2000-character cap');
    expect(text.toLowerCase()).not.toContain('internal');
  });
});
