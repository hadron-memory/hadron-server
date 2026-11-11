/**
 * #3578 / #3579 — pins on planNodeMove (cor:api:190:03): a role-writer refusal is the real move's refusal,
 * before any write, and the response bound is clamped to 1..1000 with omitted and explicit null alike.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let orgId: string; let memoryId: string; let memoryUrn: string; let destId: string;
let admin: { id: string }; let contrib: { id: string };
const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: [], clientId: `user:${u.id}` });
const urn = (loc: string) => `hrn:node:${memoryUrn.replace(/^hrn:mem:/, '')}:${loc}`;
async function rule(memory: string, role: string, writers: string) {
  const config = (await db.memoryConfig.findUnique({ where: { memoryId: memory } }))
    ?? await db.memoryConfig.create({ data: { id: generateId(), memoryId: memory } });
  return db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, writers } });
}
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: 'body', ...extra } });
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as GraphQLError);
const snapshot = async () => ({ nodes: await db.node.findMany({ orderBy: { id: 'asc' } }), revisions: await db.nodeRevision.count() });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'pin3578', urn: 'pin3578' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 357800, githubUsername: 'pin-admin', handle: 'pin-admin' } });
  contrib = await db.user.create({ data: { githubId: 357801, githubUsername: 'pin-contrib', handle: 'pin-contrib' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
  ] });
  memoryUrn = `${org.urn}:mem`;
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: memoryUrn, name: 'mem', class: 'knowledge' } })).id;
  destId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${org.urn}:dest`, name: 'dest', class: 'knowledge' } })).id;
});

describe('#3578 planNodeMove refuses a caller below the role writer level exactly as the real move', () => {
  it('same memory: contributor refused with the real code and envelope, nothing written; admin plans', async () => {
    await rule(memoryId, 'policy', 'ADMIN');
    const root = await node('p', { role: 'policy' });
    const args = { sourceRef: root.id, targetUrn: urn('moved') };
    const before = await snapshot();
    const real = await caught(M.moveNode(null, args, as(contrib)));
    expect(real?.extensions.code).toBe('ROLE_WRITER_LEVEL_REQUIRED');
    const planned = await caught(M.planNodeMove(null, args, as(contrib)));
    expect(planned?.message).toBe(real!.message);
    expect(planned?.extensions).toEqual(real!.extensions);
    expect(await snapshot()).toEqual(before);
    const ok = await M.planNodeMove(null, args, as(admin));
    expect(ok.totalCount).toBe(1);
  });

  it('cross memory: a destination rule that needs ADMIN refuses the contributor the same way', async () => {
    await rule(destId, 'policy', 'ADMIN');
    const root = await node('p', { role: 'policy' });
    const args = { sourceRef: root.id, targetMemoryRef: destId };
    const before = await snapshot();
    const real = await caught(M.moveNode(null, args, as(contrib)));
    expect(real?.extensions.code).toBe('ROLE_WRITER_LEVEL_REQUIRED');
    const planned = await caught(M.planNodeMove(null, args, as(contrib)));
    expect(planned?.message).toBe(real!.message);
    expect(planned?.extensions).toEqual(real!.extensions);
    expect(await snapshot()).toEqual(before);
    expect((await M.planNodeMove(null, args, as(admin))).totalCount).toBe(1);
  });

  it('a governed descendant (not only the source) is judged', async () => {
    await rule(memoryId, 'policy', 'ADMIN');
    const root = await node('p');
    await node('p:child', { role: 'policy' });
    const args = { sourceRef: root.id, targetUrn: urn('moved') };
    const real = await caught(M.moveNode(null, args, as(contrib)));
    expect(real?.extensions.code).toBe('ROLE_WRITER_LEVEL_REQUIRED');
    expect((await caught(M.planNodeMove(null, args, as(contrib))))?.extensions).toEqual(real!.extensions);
  });
});

describe('#3579 planNodeMove limit bounds', () => {
  const seed = async (count: number) => {
    const root = await node('a');
    await db.node.createMany({ data: Array.from({ length: count - 1 }, (_, i) => ({ id: generateId(), memoryId, loc: `a:n${String(i).padStart(4, '0')}`, name: `n${i}`, content: 'body' })) });
    return { sourceRef: root.id, targetUrn: urn('z') };
  };
  const plan = (args: object, limit?: number | null) => M.planNodeMove(null, limit === undefined ? args : { ...args, limit }, as(admin));

  it.each([0, -5])('limit %i is floored to one row and discloses truncation', async limit => {
    const args = await seed(3);
    const p = await plan(args, limit);
    expect(p.nodes).toHaveLength(1);
    expect(p.totalCount).toBe(3);
    expect(p.truncated).toBe(true);
  });

  it('limit 5000 is capped at 1000 rows over a 1001-node subtree, truncated with the full count', async () => {
    const args = await seed(1001);
    const p = await plan(args, 5000);
    expect(p.nodes).toHaveLength(1000);
    expect(p.totalCount).toBe(1001);
    expect(p.truncated).toBe(true);
    const exact = await plan(args, 1001);
    expect(exact.nodes).toHaveLength(1000);
  });

  it('a limit equal to the subtree size is not truncated', async () => {
    const args = await seed(3);
    const p = await plan(args, 3);
    expect(p.nodes).toHaveLength(3);
    expect(p.truncated).toBe(false);
  });

  it('omitted and explicit null both mean the default of 100 (decision #3579)', async () => {
    const args = await seed(150);
    const omitted = await plan(args);
    const nulled = await plan(args, null);
    expect(omitted.nodes).toHaveLength(100);
    expect(nulled.nodes).toEqual(omitted.nodes);
    expect(nulled.totalCount).toBe(150);
    expect(nulled.truncated).toBe(true);
  });
});
