/**
 * #5018 (Billing A14): the hand-run backfill that fills `stored_bytes` and `revision_bytes` on rows written before the triggers
 * existed. Dry run by default; applied in bounded, resumable batches; writes only the two columns, so `updated_at`, `rev_seq` and
 * `revision_content_hash` stay as they were; and a concurrent revision insert, in either order, leaves the node equal to a full
 * recomputation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createNodeRevision } from '../lib/nodeRevisionSnapshot.js';
import { backfillNodeBytes, fillNodeBytesBatch, parseBackfillArgs } from './backfillNodeBytes.js';

let memoryId: string;
let seq = 0;
type Row = { id: string; stored: number | null; revision: bigint | null; updated: Date; revSeq: number; hash: string | null };
const rows = (ids: string[]) => db.$queryRaw<Row[]>`
  SELECT id, stored_bytes AS stored, revision_bytes AS revision, updated_at AS updated, rev_seq AS "revSeq", revision_content_hash AS hash
  FROM nodes WHERE id = ANY(${ids}) ORDER BY id`;
const recomputed = async (nodeId: string) => (await db.$queryRaw<Array<{ stored: number; revision: bigint }>>`
  SELECT (COALESCE(octet_length(n.content), 0) + COALESCE(octet_length(n.description), 0)
          + COALESCE(octet_length(n.data::text), 0) + COALESCE(octet_length(n.properties::text), 0))::int AS stored,
         COALESCE((SELECT sum(COALESCE(octet_length(r.content), 0) + COALESCE(octet_length(r.description), 0)
                            + COALESCE(octet_length(r.data::text), 0) + COALESCE(octet_length(r.properties::text), 0))
                   FROM node_revisions r WHERE r.node_id = n.id), 0)::bigint AS revision
  FROM nodes n WHERE n.id = ${nodeId}`)[0];
const unmeasure = (ids: string[]) => db.$executeRaw`UPDATE nodes SET stored_bytes = NULL, revision_bytes = NULL WHERE id = ANY(${ids})`;
const mkNode = (data: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: `n-${++seq}`, name: 'n', ...data } as never });
const snapshotOf = async (nodeId: string, tx: Pick<typeof db, 'node' | 'nodeRevision' | 'memory' | 'nodeSignature' | '$queryRaw'> = db) => {
  const n = await tx.node.findUniqueOrThrow({ where: { id: nodeId } });
  await createNodeRevision(tx, { nodeId, memoryId: n.memoryId, loc: n.loc, name: n.name, content: n.content, nodeType: n.nodeType, tags: [] } as never);
};
/** A node written before the triggers existed: figures null, with some history. */
const legacy = async (content: string, revisions = 1) => {
  const n = await mkNode({ content });
  for (let i = 0; i < revisions; i++) await snapshotOf(n.id);
  await unmeasure([n.id]);
  return n.id;
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
/** Waits until some other statement of this database is blocked on a lock (so a test that asserts "still waiting" has something to assert about). */
const waitForLockWait = async (timeoutMs = 10_000) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (n > 0n) return;
    if (Date.now() > until) throw new Error('no statement ever waited on a lock');
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'bf', urn: 'bf5018' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), name: 'm', urn: 'bf5018:m', class: 'knowledge', organizationId: org.id } as never })).id;
});

describe('#5018 the backfill fills every null row', () => {
  it('is a dry run by default: it reports and writes nothing', async () => {
    const id = await legacy('abc');
    const report = await backfillNodeBytes(db, {});
    expect(report).toMatchObject({ mode: 'dry-run', scanned: 1, filled: 0, complete: true });
    expect((await rows([id]))[0]).toMatchObject({ stored: null, revision: null });
  });

  it('fills both columns of every null row, equal to a recomputation from the rows', async () => {
    const ids = [await legacy('abc', 2), await legacy('defgh'), await legacy('')];
    const report = await backfillNodeBytes(db, { apply: true });
    expect(report).toMatchObject({ mode: 'apply', filled: 3, complete: true, cursor: null });
    for (const id of ids) expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
    expect((await rows([ids[0]!]))[0]!.revision).toBe(6n);
  });

  it('changes nothing on a second run', async () => {
    const ids = [await legacy('abc'), await legacy('defgh')];
    await backfillNodeBytes(db, { apply: true });
    const before = await rows(ids);
    const again = await backfillNodeBytes(db, { apply: true });
    expect(again).toMatchObject({ scanned: 0, filled: 0, complete: true });
    expect(await rows(ids)).toEqual(before);
  });

  it('fills a row with only one column null', async () => {
    const id = await legacy('abc');
    await db.$executeRaw`UPDATE nodes SET stored_bytes = 3 WHERE id = ${id}`;
    await backfillNodeBytes(db, { apply: true });
    expect((await rows([id]))[0]).toMatchObject({ stored: 3, revision: 3n });
  });

  it('never changes updated_at, rev_seq or revision_content_hash', async () => {
    const ids = [await legacy('abc'), await legacy('defgh', 3)];
    const before = await rows(ids);
    await backfillNodeBytes(db, { apply: true });
    const after = await rows(ids);
    for (const [i, row] of after.entries()) {
      expect(row.updated).toEqual(before[i]!.updated);
      expect(row.revSeq).toBe(before[i]!.revSeq);
      expect(row.hash).toBe(before[i]!.hash);
    }
  });
});

describe('#5018 the backfill is bounded and resumable', () => {
  it('stops at --limit, says so, and a run from its cursor finishes the walk', async () => {
    const ids = [await legacy('a'), await legacy('bb'), await legacy('ccc'), await legacy('dddd')];
    const first = await backfillNodeBytes(db, { apply: true, limit: 2, batch: 1 });
    expect(first).toMatchObject({ filled: 2, complete: false });
    expect(first.cursor).not.toBeNull();
    expect((await rows(ids)).filter((r) => r.stored === null)).toHaveLength(2);
    const rest = await backfillNodeBytes(db, { apply: true, after: first.cursor });
    expect(rest).toMatchObject({ filled: 2, complete: true, cursor: null });
    for (const id of ids) expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
  });

  it('walks lowest id first and --after skips everything up to it', async () => {
    const ids = [await legacy('a'), await legacy('bb'), await legacy('ccc')].sort();
    const report = await backfillNodeBytes(db, { apply: true, after: ids[1] });
    expect(report.filled).toBe(1);
    const filled = (await rows(ids)).map((r) => r.stored !== null);
    expect(filled).toEqual([false, false, true]);
  });

  it('refuses an unknown or malformed flag instead of dropping a bound', () => {
    expect(() => parseBackfillArgs(['--aply'])).toThrow();
    expect(() => parseBackfillArgs(['--batch', '0'])).toThrow();
    expect(() => parseBackfillArgs(['--limit', '-1'])).toThrow();
    expect(parseBackfillArgs(['--apply', '--batch', '5', '--limit', '9', '--after', 'abc'])).toEqual({ apply: true, batch: 5, limit: 9, after: 'abc' });
  });
});

describe('#5018 against a concurrent revision insert, in either order, the node ends equal to a full recomputation', () => {
  it('a revision insert that has locked the node first: the backfill waits, then counts the new revision', async () => {
    const id = await legacy('abc');
    let release!: () => void;
    let inserted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
    const writer = db.$transaction(async (tx) => {
      await snapshotOf(id, tx as never);
      inserted();
      await held;
    }, { timeout: 20_000 });
    await insertedSignal;
    const filler = backfillNodeBytes(db, { apply: true });
    await waitForLockWait();
    release();
    await Promise.all([writer, filler]);
    expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
  });

  it('a backfill batch that has locked the node first: the revision insert waits, then adds its difference', async () => {
    const id = await legacy('abc');
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
    const batch = db.$transaction(async (tx) => {
      const result = await fillNodeBytesBatch(tx as never, { after: null, batch: 10 });
      locked();
      await held;
      return result;
    }, { timeout: 20_000 });
    await lockedSignal;
    let writerDone = false;
    const writer = snapshotOf(id).then(() => { writerDone = true; });
    await waitForLockWait();
    expect(writerDone).toBe(false);
    release();
    await Promise.all([batch, writer]);
    expect(writerDone).toBe(true);
    expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
  });
});

describe('#5018 a concurrent revision DELETE or rewrite, which takes no node lock on a node that is not measured yet', () => {
  it('a revision deleted in a transaction the backfill must wait for: the node ends equal to a recomputation', async () => {
    const id = await legacy('abc', 2);
    let release!: () => void;
    let deleted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const deletedSignal = new Promise<void>((resolve) => { deleted = resolve; });
    const writer = db.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM node_revisions WHERE id = (SELECT id FROM node_revisions WHERE node_id = ${id} ORDER BY id LIMIT 1)`;
      deleted();
      await held;
    }, { timeout: 20_000 });
    await deletedSignal;
    const filler = backfillNodeBytes(db, { apply: true });
    await waitForLockWait();
    release();
    await Promise.all([writer, filler]);
    expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
    expect((await rows([id]))[0]!.revision).toBe(3n);
  });

  it('a revision rewritten in place in such a transaction: the same', async () => {
    const id = await legacy('abc', 1);
    let release!: () => void;
    let rewritten!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rewrittenSignal = new Promise<void>((resolve) => { rewritten = resolve; });
    const writer = db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE node_revisions SET content = 'abcdefghij' WHERE node_id = ${id}`;
      rewritten();
      await held;
    }, { timeout: 20_000 });
    await rewrittenSignal;
    const filler = backfillNodeBytes(db, { apply: true });
    await waitForLockWait();
    release();
    await Promise.all([writer, filler]);
    expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
    expect((await rows([id]))[0]!.revision).toBe(10n);
  });

  it('a backfill batch that holds its locks first: a revision delete waits, then applies its difference', async () => {
    const id = await legacy('abc', 2);
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
    const batch = db.$transaction(async (tx) => {
      const result = await fillNodeBytesBatch(tx as never, { after: null, batch: 10 });
      locked();
      await held;
      return result;
    }, { timeout: 20_000 });
    await lockedSignal;
    let deleteDone = false;
    const writer = db.$executeRaw`DELETE FROM node_revisions WHERE id = (SELECT id FROM node_revisions WHERE node_id = ${id} ORDER BY id LIMIT 1)`.then(() => { deleteDone = true; });
    await waitForLockWait();
    expect(deleteDone).toBe(false);
    release();
    await Promise.all([batch, writer]);
    expect((await rows([id]))[0]).toMatchObject(await recomputed(id));
    expect((await rows([id]))[0]!.revision).toBe(3n);
  });
});
