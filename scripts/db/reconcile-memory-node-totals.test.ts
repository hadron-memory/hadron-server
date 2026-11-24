/** #5078: the operator tool that compares the stored per-memory node totals with a recount and repairs them. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { expectNodeTotalsExact } from '../../src/test/nodeTotals.js';
import { generateId } from '../../src/lib/id.js';
import { main as reconcile } from './reconcile-memory-node-totals.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let a1: { id: string };
let a2: { id: string };
let b1: { id: string };
const node = (memoryId: string, loc: string) => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'nt-r', urn: 'nt-r' } });
  [a1, a2, b1] = await Promise.all(['a1', 'a2', 'b1'].map((s) => db.memory.create({ data: {
    id: generateId(), name: s, urn: `nt-r:${s}`, class: 'knowledge', organizationId: org.id } })));
});

describe('#5078 scripts/db/reconcile-memory-node-totals.ts', () => {
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await reconcile(argv, { env: process.env, log: (l) => lines.push(l) });
    return { code, lines };
  };
  /** Every write in here happens with the triggers off. */
  async function untracked(write: () => Promise<unknown>) {
    const triggers = await db.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname::text FROM pg_trigger WHERE tgrelid = 'nodes'::regclass AND tgname LIKE 'memory_node_total%'`;
    expect(triggers.length).toBeGreaterThanOrEqual(4);
    for (const t of triggers) await db.$executeRawUnsafe(`ALTER TABLE nodes DISABLE TRIGGER ${t.tgname}`);
    try { await write(); } finally {
      for (const t of triggers) await db.$executeRawUnsafe(`ALTER TABLE nodes ENABLE TRIGGER ${t.tgname}`);
    }
  }

  it('reports exactly the drifted memories, repairs them, and then reports nothing', async () => {
    const [n] = [await node(a1.id, 'n'), await node(b1.id, 'ok')];
    await untracked(async () => {
      await db.node.delete({ where: { id: n.id } });
      for (let i = 0; i < 3; i++) await node(a2.id, `n${i}`);
    });
    const tag = 'db.memory_node_totals_reconcile';
    const drift = [[a1.id, 1, 0], [a2.id, 0, 3]].sort(([x], [y]) => (x! < y! ? -1 : 1))
      .map(([id, stored, counted]) => `${tag}.drift memory=${id} stored=${stored} counted=${counted}`);
    expect(await run()).toEqual({ code: 1, lines: [...drift, `${tag} dry_run drifted=2`] });
    expect(await run('--apply')).toEqual({ code: 0, lines: [...drift, `${tag} applied drifted=2`] });
    await expectNodeTotalsExact(db);
    expect(await run()).toEqual({ code: 0, lines: [`${tag} dry_run drifted=0`] });
  });

  it('a negative figure never fails a delete and is reported', async () => {
    const n = await node(a1.id, 'n');
    await db.$executeRaw`UPDATE memory_node_totals SET live_nodes = 0 WHERE memory_id = ${a1.id}`;
    await db.node.delete({ where: { id: n.id } });
    expect((await run()).lines[0]).toContain('stored=-1 counted=0');
  });

  it('--apply racing concurrent inserts into the same memory ends exact', async () => {
    await untracked(async () => { for (let i = 0; i < 5; i++) await node(a1.id, `n${i}`); });
    await Promise.all([run('--apply'), ...Array.from({ length: 15 }, (_, i) => db.$transaction((tx) =>
      tx.node.create({ data: { id: generateId(), memoryId: a1.id, loc: `r${i}`, name: 'n' } }), { maxWait: 30_000 }))]);
    expect(await db.node.count({ where: { memoryId: a1.id } })).toBe(20);
    await expectNodeTotalsExact(db);
  });

  it('refuses unknown arguments and a missing URL, and never prints the URL on a failure', async () => {
    expect((await run('--force')).code).toBe(2);
    const lines: string[] = [];
    const io = (env: NodeJS.ProcessEnv) => ({ env, log: (l: string) => lines.push(l) });
    expect(await reconcile([], io({}))).toBe(2);
    expect(await reconcile([], io({ DATABASE_URL: 'postgresql://nobody:hunter2@127.0.0.1:1/none' }))).toBe(1);
    expect(lines.join('\n')).not.toMatch(/hunter2|127\.0\.0\.1/);
  });
});
