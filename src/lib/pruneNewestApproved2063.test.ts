/** #2063 replacement P4: retain ONE newest qualifying revision, not all covered siblings. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { revisionsExemptFromPruning } from './nodeRevisionSnapshot.js';
import { resolveNodeContent, BROKEN_INCLUDE_NOTICE } from './includes/resolveNodeContent.js';
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

it('retention does not mistake the serving scan budget for no approved revision', async () => {
  const n = await node('beyond-budget');
  await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, ctx());
  await edit(n.id, { tags: ['covered'] });
  await edit(n.id, { content: 'unapproved' }); // approved non-carrier snapshot 2
  // Seed unrelated retained revisions directly: the helper must examine more
  // than the read surface's 100-candidate budget without changing that default.
  await db.nodeRevision.createMany({ data: Array.from({ length: 105 }, (_, i) => ({
    id: generateId(), nodeId: n.id, memoryId, loc: n.loc, name: n.name,
    content: `not approved ${i}`, tags: [], revNo: i + 10,
  })) });
  await db.node.update({ where: { id: n.id }, data: { revSeq: 120 } });
  expect(await newestApprovedRevisionOf(db, n.id)).toEqual({ found: null, truncated: true });
  expect([...await revisionsExemptFromPruning(db, n.id, memoryId)]).toContain(2);
});
it('encrypted qualification is not revived by the new exemption', async () => {
  const n = await node('encrypted');
  await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, ctx());
  await edit(n.id, { tags: ['covered'] });
  await edit(n.id, { content: 'unapproved' });
  await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, vectorIndexEnabled: false } });
  const exempt = [...await revisionsExemptFromPruning(db, n.id, memoryId)];
  expect(exempt).toContain(1); // carrier rule remains independent
  expect(exempt).not.toContain(2); // no decryption/qualification scan
});

it('a live or soft-deleted plain-pin includer grants no exemption and a pruned pin is broken', async () => {
  const target = await node('plain-target');
  const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain-source', name: 'Source', content: '{{> plain-target rev=1}}' } });
  await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 1 } });
  await edit(target.id, { content: 'second' });
  await db.node.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
  await edit(target.id, { content: 'third' });
  expect(await db.nodeRevision.count({ where: { nodeId: target.id, revNo: 1 } })).toBe(0);
  await db.node.update({ where: { id: source.id }, data: { deletedAt: null } });
  expect(await resolveNodeContent(ctx(), source)).toContain(BROKEN_INCLUDE_NOTICE);
});


it('#2751 bounds absence work at a real cap write without changing ordinary pruning', async () => {
  const n = await node('never-approved-work');
  await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 200 } });
  for (let i = 0; i < 35; i++) await edit(n.id, { content: `ordinary ${i}` });
  await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 3 } });
  const before = await db.nodeRevision.findMany({ where: { nodeId: n.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  let qualificationReads = 0;
  let absenceProbes = 0;
  let snapshots = 0;
  const transaction = db.$transaction.bind(db);
  const observed = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key, target);
    return (action: any, options: any) => transaction(async tx => action(new Proxy(tx, { get(t, k) {
      if (k !== 'nodeRevision') return Reflect.get(t, k, t);
      return new Proxy(t.nodeRevision, { get(model, method) {
        if (!['findMany', 'findFirst', 'create'].includes(String(method))) return Reflect.get(model, method, model);
        return (args: any) => {
          if (method === 'findMany' && args.where?.approvedAt?.not === null) qualificationReads++;
          if (method === 'findFirst' && args.where?.approvalHash?.not === null) absenceProbes++;
          if (method === 'create') snapshots++;
          return (Reflect.get(model, method, model) as Function).call(model, args);
        };
      } });
    } })), options);
  } });
  await resolvers.Mutation.updateNode(null, { input: { id: n.id, content: 'cap write' } }, { ...ctx(), db: observed });
  expect(snapshots).toBeGreaterThan(0); // interception reached the actual locked write
  expect(qualificationReads).toBe(0);
  expect(absenceProbes).toBe(1);
  const retained = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
  expect(retained).toHaveLength(3);
  // The new snapshot plus the two newest old rows, exactly the ordinary cap.
  expect(retained.map(r => r.id)).toEqual(expect.arrayContaining(before.slice(0, 2).map(r => r.id)));
});
