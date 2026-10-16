/**
 * #1856 — the encrypted-state lookup behind `Node.approvalStatus` and `Node.mintStatus`, on a list page.
 *
 * Each status field asks whether the node's memory is encrypted (an encrypted memory's nodes read
 * NOT_APPLICABLE / no mint record, whatever columns they retain). Before #1856 that cost a
 * `memory.findUnique` per field, plus a `node.findUnique` per field for a parent selected without its
 * `memoryId`: about 2N queries on a mixed page.
 *
 * The first block pins TODAY's outputs on a mixed page, so the batching is checked against a recorded
 * baseline rather than a re-derivation. It is green before and after the change. The second block is the
 * acceptance: the page's encrypted-state lookups cost one memory query, and one node query for the
 * parents lacking a memoryId. The third pins the guards: the flag comes from the stored memory, never a
 * decrypted parent's projection, and nothing is reused across requests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const N = resolvers.Node as any;
const M = resolvers.Mutation as any;
let admin: { id: string };
let plain: { id: string };
let secret: { id: string };
const as = (): Context => ({ db, userId: admin.id, roles: [] });

type Row = Record<string, unknown> & { id: string };
const ids: Record<string, string> = {};

async function mk(key: string, memoryId: string) {
  ids[key] = (await db.node.create({ data: { id: generateId(), memoryId, loc: key, name: `T ${key}`, content: `B ${key}` } })).id;
}
const mint = (key: string) =>
  db.node.update({ where: { id: ids[key] }, data: { mintedAt: new Date('2026-10-01T00:00:00Z'), mintedBy: admin.id, mintedRevNo: 1, mintedHash: `h-${key}` } });

/** A parent as a list projection hands it over: the full row, or the row without memoryId. */
async function parent(key: string, withMemoryId = true): Promise<Row> {
  const row: Row = { ...(await db.node.findUniqueOrThrow({ where: { id: ids[key] } })) };
  if (!withMemoryId) delete row.memoryId;
  return row;
}

/** Both status fields for a whole page, resolved together on one request, as GraphQL does. */
async function page(parents: Row[], ctx = as()) {
  return Promise.all(parents.map(async (p) => {
    const [a, m] = await Promise.all([N.approvalStatus(p, {}, ctx), N.mintStatus(p, {}, ctx)]);
    return { state: a.state, approvedRevision: a.approval?.revision ?? null, minted: m.minted, hash: m.hash ?? null };
  }));
}

async function fixture() {
  await mk('approved', plain.id);
  await mk('superseded', plain.id);
  await mk('bare', plain.id);
  await mk('retained', secret.id);
  await mk('retained2', secret.id);
  for (const k of ['approved', 'superseded', 'retained', 'retained2']) await M.approveNode(null, { nodeRef: ids[k] }, as());
  await M.updateNode(null, { input: { id: ids.superseded, content: 'moved on' } }, as());
  for (const k of ['approved', 'retained', 'retained2']) await mint(k);
  // Encrypt after the records exist: the columns are RETAINED, and must not show.
  await db.memory.update({ where: { id: secret.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
  return [
    await parent('approved'),
    await parent('superseded', false),
    await parent('bare'),
    await parent('retained'),
    await parent('retained2', false),
  ];
}

const BASELINE = [
  { state: 'APPROVED', approvedRevision: 1, minted: true, hash: 'h-approved' },
  { state: 'SUPERSEDED', approvedRevision: 1, minted: false, hash: null },
  { state: 'NOT_APPROVED', approvedRevision: null, minted: false, hash: null },
  { state: 'NOT_APPLICABLE', approvedRevision: null, minted: false, hash: null },
  { state: 'NOT_APPLICABLE', approvedRevision: null, minted: false, hash: null },
];

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Enc Batch', urn: `encbatch-${Date.now()}.example` } });
  admin = await db.user.create({ data: { githubId: 185601 + Math.floor(Math.random() * 1000), githubUsername: `encbatch-${Date.now()}`, roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  plain = await M.createMemory(null, { orgId: org.id, name: 'plain' }, as());
  secret = await M.createMemory(null, { orgId: org.id, name: 'secret' }, as());
});

describe('behaviour comparison: the mixed page reads as it did before #1856', () => {
  it('plaintext and encrypted, with and without memoryId, retained records hidden', async () => {
    expect(await page(await fixture())).toEqual(BASELINE);
  });

  it('a parent with no memoryId whose node is gone reads as having no record', async () => {
    await mk('ghost', plain.id);
    const p = await parent('ghost', false);
    await db.node.delete({ where: { id: ids.ghost } });
    expect(await page([p])).toEqual([{ state: 'NOT_APPROVED', approvedRevision: null, minted: false, hash: null }]);
  });
});

describe('the query budget (the acceptance)', () => {
  it('one memory query for the whole page, and one node query for the parents lacking a memoryId', async () => {
    const parents = await fixture();
    const memUnique = vi.spyOn(db.memory, 'findUnique');
    const memMany = vi.spyOn(db.memory, 'findMany');
    const nodeUnique = vi.spyOn(db.node, 'findUnique');
    const nodeMany = vi.spyOn(db.node, 'findMany');
    /** A node read that only asks for memoryId: the encrypted-state parent resolution, nothing else. */
    const memoryIdOnly = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([a]) => {
        const keys = Object.keys((a as { select?: object })?.select ?? {});
        return keys.includes('memoryId') && keys.every((k) => k === 'memoryId' || k === 'id');
      }).length;
    try {
      expect(await page(parents)).toEqual(BASELINE);
      expect(memUnique.mock.calls.length + memMany.mock.calls.length).toBe(1);
      expect(memoryIdOnly(nodeUnique) + memoryIdOnly(nodeMany)).toBe(1);
    } finally {
      for (const s of [memUnique, memMany, nodeUnique, nodeMany]) s.mockRestore();
    }
  });
});

describe('the guards', () => {
  it('the stored memory decides, never a decrypted parent\'s projection', async () => {
    const parents = await fixture();
    const spoofed = parents.map((p) => ({ ...p, isEncrypted: false, memory: { id: secret.id, isEncrypted: false } }));
    expect(await page(spoofed)).toEqual(BASELINE);
  });

  it('nothing is reused across requests, nor across ticks of one request', async () => {
    const parents = await fixture();
    const ctx = as();
    expect(await page(parents, ctx)).toEqual(BASELINE);
    await db.memory.update({ where: { id: secret.id }, data: { isEncrypted: false } });
    const afterDecrypt = await page(parents, ctx);
    expect(afterDecrypt[3]).toEqual({ state: 'APPROVED', approvedRevision: 1, minted: true, hash: 'h-retained' });
    await db.memory.update({ where: { id: secret.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(await page(parents, as())).toEqual(BASELINE);
  });

  it('a failed lookup fails the fields; it never reads as plaintext', async () => {
    const parents = await fixture();
    const spy = vi.spyOn(db.memory, 'findMany').mockRejectedValueOnce(new Error('connection reset'));
    const spyU = vi.spyOn(db.memory, 'findUnique').mockRejectedValue(new Error('connection reset'));
    try {
      await expect(N.approvalStatus(parents[3], {}, as())).rejects.toThrow(/connection reset/);
    } finally {
      spy.mockRestore();
      spyU.mockRestore();
    }
  });
});
