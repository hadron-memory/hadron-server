/** #2063 replacement P4: retain ONE newest qualifying revision, not all covered siblings. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { revisionsExemptFromPruning } from './nodeRevisionSnapshot.js';
import { newestApprovedRevisionOf } from './nodeApproval.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string;
let memoryId: string;
const ctx = (): Context => ({ db, userId, roles: [] });
const edit = (id: string, input: Record<string, unknown>) => resolvers.Mutation.updateNode(null, { input: { id, ...input } }, ctx());
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Prune Test', urn: 'prune2063.example' } });
  const user = await db.user.create({ data: { githubId: 206301, githubUsername: 'prune2063', handle: 'prune2063', roles: [] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'prune2063' }, ctx());
  memoryId = memory.id;
});
async function node(loc: string) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: 'Stable title', content: 'approved text' } });
}
it('keeps the newest covered non-carrier through a small cap, but prunes older covered siblings', async () => {
  const n = await node('covered');
  await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, ctx()); // carrier 1
  await edit(n.id, { tags: ['a'] }); // covered 2
  await edit(n.id, { tags: ['b'] }); // covered 3
  await edit(n.id, { content: 'unapproved' }); // snapshot 3
  expect((await newestApprovedRevisionOf(db, n.id)).found?.revNo).toBe(3);
  expect([...await revisionsExemptFromPruning(db, n.id, memoryId)]).toEqual(expect.arrayContaining([1, 3]));
  await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 1 } });
  for (let i = 0; i < 4; i++) await edit(n.id, { content: `ordinary ${i}` });
  const rows = await db.nodeRevision.findMany({ where: { nodeId: n.id }, select: { revNo: true } });
  const kept = rows.map(r => r.revNo);
  expect(kept).toContain(1);
  expect(kept).toContain(3);
  expect(kept).not.toContain(2);
  expect(kept.length).toBe(3); // carrier + newest covered + cap
  expect((await newestApprovedRevisionOf(db, n.id)).found?.revNo).toBe(3);
});
it('a later qualifying sibling replaces the old extra exemption', async () => {
  const n = await node('replacement');
  await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, ctx());
  await edit(n.id, { tags: ['a'] });
  await edit(n.id, { content: 'different' }); // covered snapshot 2
  expect([...await revisionsExemptFromPruning(db, n.id, memoryId)]).toContain(2);
  await edit(n.id, { content: 'approved text' }); // live 4 covered by carrier 1
  await edit(n.id, { content: 'different again' }); // covered snapshot 4
  const exempt = [...await revisionsExemptFromPruning(db, n.id, memoryId)];
  expect(exempt).toContain(4);
  expect(exempt).not.toContain(2);
});
it('never-approved revisions add no exemption and ordinary history still prunes', async () => {
  const n = await node('ordinary');
  await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 1 } });
  for (let i = 0; i < 4; i++) await edit(n.id, { content: `ordinary ${i}` });
  expect((await revisionsExemptFromPruning(db, n.id, memoryId)).size).toBe(0);
  expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
});
