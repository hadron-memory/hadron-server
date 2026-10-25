/**
 * #1997 — the one-time scrub of node_embeddings rows tagged with a memory their
 * node left before #409 (migration 20261025030000_scrub_mistagged_node_embeddings).
 *
 * The shipped file is the thing under test: whole-file runs go through psql, and
 * the race pins run its `-- @step` statements one by one in one transaction so a
 * competing transaction can act between them. The step runner has no retry
 * loop, so a busy lock surfaces there as the NOWAIT error the loop catches;
 * the loop itself is pinned by whole-file runs racing a lock holder.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { waitForLockWaiters } from '../lockWait.js';
import { upsertAbstractVector } from '../../services/embedding/vectors.js';
import { restampFailedEmbeddings } from '../../services/embedding/enqueue.js';
import { endApprovalsOnEncryptedEntry } from '../../lib/nodeApproval.js';
import { RAW_CHAT_TURN_LOC_PATTERN } from '../../services/embedding/rawChat.js';

const run = promisify(execFile);
const FILE = resolve('prisma/migrations/20261025030000_scrub_mistagged_node_embeddings/migration.sql');
const read = () => readFileSync(FILE, 'utf8');

/** One attempt's statements, `-- @step` to `-- @end`, keyed by step name; PERFORM read as SELECT. */
function steps(): Array<{ name: string; sql: string }> {
  const body = read().split(/^\s*-- @end$/m)[0];
  return body.split(/^\s*-- @step /m).slice(1).map((chunk) => ({
    name: /^[\w-]+/.exec(chunk)![0],
    sql: chunk.replace(/^.*$/m, '').replace(/^\s*--.*$/gm, '').trim().replace(/^PERFORM\b/, 'SELECT'),
  }));
}

const APP = 'scrub-1997-file';

/** Run the whole shipped file, BEGIN to COMMIT, as migrate deploy would. */
async function runFile(opts: { attempts?: number } = {}): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  await run('psql', ['--no-psqlrc', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FILE], {
    env: {
      ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGAPPNAME: APP,
      ...(opts.attempts ? { PGOPTIONS: `-c hadron.scrub_1997_attempts=${opts.attempts}` } : {}),
    },
    timeout: 30_000,
  });
}

/** Resolve once the file's retry loop has yielded at least once: it is sleeping between attempts. */
async function waitForScrubRetry(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ sleeping }] = await db.$queryRaw<Array<{ sleeping: number }>>`
      SELECT count(*)::int AS sleeping FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${APP} AND wait_event = 'PgSleep'`;
    if (sleeping > 0) return;
    if (Date.now() > deadline) throw new Error(`waitForScrubRetry: the scrub never yielded within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The SQLSTATE a rejected Prisma raw query carries. */
function sqlstate(e: unknown): string | undefined {
  const m = /Code: `(\w{5})`|SQLSTATE (\w{5})|"code":"(\w{5})"/.exec(String((e as Error)?.message ?? e));
  return (e as { meta?: { code?: string } })?.meta?.code ?? (m ? m[1] ?? m[2] ?? m[3] : undefined);
}

/** Run the steps in one transaction, calling `after[name]` once that step has run. */
async function runSteps(after: Partial<Record<string, () => Promise<void>>> = {}): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const s of steps()) {
      if (/^SELECT/i.test(s.sql)) await tx.$queryRawUnsafe(s.sql);
      else await tx.$executeRawUnsafe(s.sql);
      await after[s.name]?.();
    }
  }, { timeout: 30_000, maxWait: 10_000 });
}

type Mem = { id: string };
async function memory(opts: { indexed?: boolean; encrypted?: boolean; system?: boolean; deleted?: boolean } = {}): Promise<Mem> {
  const id = generateId();
  return db.memory.create({
    data: {
      id, organizationId: orgId, urn: `scrub-1997:m${id}`, name: `m${id}`,
      class: opts.system ? 'system' : 'knowledge',
      vectorIndexEnabled: !!opts.indexed,
      isEncrypted: !!opts.encrypted,
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    },
    select: { id: true },
  });
}

const OLD_TOKEN = '00000000-0000-4000-8000-000000000001';
const FUTURE = new Date('2099-01-01T00:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');

/** A node whose rows are tagged `tagged` while the node itself sits in `home`. */
async function node(home: Mem, opts: {
  tagged?: Mem; correctRows?: boolean; markers?: boolean; deleted?: boolean; nodeType?: string; loc?: string;
} = {}): Promise<string> {
  const id = generateId();
  const tagged = opts.tagged ?? home;
  await db.node.create({
    data: {
      id, memoryId: tagged.id, loc: opts.loc ?? `n${id}`, name: 'synthetic', ownerRepo: 'test/repo', tags: [],
      nodeType: opts.nodeType ?? 'info',
      content: 'synthetic body', abstract: 'synthetic summary',
      ...(opts.markers ? {
        embeddingPendingAt: FUTURE, embeddingWorkToken: OLD_TOKEN, embeddingFailedAt: PAST,
        embeddingAttempts: 5, embeddingError: 'synthetic retry',
      } : {}),
    },
  });
  await vec(id, tagged.id, 'abstract');
  await vec(id, tagged.id, 'chunk', 0);
  await vec(id, tagged.id, 'chunk', 1);
  // The pre-#409 merge: the node moved, its rows did not.
  if (tagged.id !== home.id) await db.$executeRaw`UPDATE nodes SET memory_id = ${home.id} WHERE id = ${id}`;
  if (opts.correctRows) await vec(id, home.id, 'chunk', 7);
  if (opts.deleted) await db.$executeRaw`UPDATE nodes SET deleted_at = now() WHERE id = ${id}`;
  return id;
}

async function vec(nodeId: string, memoryId: string, kind: 'abstract' | 'chunk', idx?: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, chunk_text, created_at)
    VALUES (${generateId()}, ${nodeId}, ${memoryId}, ${kind}::"EmbeddingKind", 'synthetic', 'synthetic', 768,
            ${idx ?? null}, ${kind === 'chunk' ? 'synthetic chunk' : null}, now())`;
}

type NodeRow = {
  memory_id: string; content: string | null; abstract: string | null; updated_at: Date; rev_seq: number;
  deleted_at: Date | null; embedding_pending_at: Date | null; token: string | null; embedding_failed_at: Date | null;
  embedding_attempts: number; embedding_error: string | null;
};

/** Every row of a node: its own columns that must not move, and its vector rows' tags. */
async function state(id: string) {
  const [n] = await db.$queryRaw<NodeRow[]>`
    SELECT memory_id, content, abstract, updated_at, rev_seq, deleted_at,
           embedding_pending_at, embedding_work_token::text AS token, embedding_failed_at,
           embedding_attempts, embedding_error
    FROM nodes WHERE id = ${id}`;
  const rows = await db.$queryRaw<Array<{ memory_id: string; kind: string; chunk_index: number | null }>>`
    SELECT memory_id, kind::text, chunk_index FROM node_embeddings WHERE node_id = ${id} ORDER BY kind, chunk_index`;
  const revisions = await db.nodeRevision.count({ where: { nodeId: id } });
  return { ...n, rows, revisions };
}

function markers(s: Awaited<ReturnType<typeof state>>) {
  const { embedding_pending_at, token, embedding_failed_at, embedding_attempts, embedding_error } = s;
  return { embedding_pending_at, token, embedding_failed_at, embedding_attempts, embedding_error };
}

function expectCleared(s: Awaited<ReturnType<typeof state>>) {
  expect(markers(s)).toEqual({
    embedding_pending_at: null, token: null, embedding_failed_at: null, embedding_attempts: 0, embedding_error: null,
  });
}

function expectRequeued(s: Awaited<ReturnType<typeof state>>, notBefore: Date) {
  const m = markers(s);
  expect(m.token).toEqual(expect.any(String));
  expect(m.token).not.toBe(OLD_TOKEN);
  const due = (m.embedding_pending_at as Date).getTime();
  expect(due).toBeGreaterThanOrEqual(notBefore.getTime() - 1000);
  expect(due).toBeLessThanOrEqual(Date.now()); // due now: a future backoff is discarded
  expect([m.embedding_failed_at, m.embedding_attempts, m.embedding_error]).toEqual([null, 0, null]);
}

/** The node's own columns, everything except the four markers and the token. */
function untouched(s: Awaited<ReturnType<typeof state>>) {
  const { content, abstract, updated_at, rev_seq, deleted_at, memory_id, revisions } = s;
  return { content, abstract, updated_at, rev_seq, deleted_at, memory_id, revisions };
}

let orgId: string;
beforeEach(async () => {
  await cleanDb(db);
  orgId = generateId();
  await db.organization.create({ data: { id: orgId, name: 'scrub-1997', urn: 'scrub-1997' } });
});

describe('#1997 scrub: which rows go and what each affected node carries afterwards', { timeout: 30_000 }, () => {
  it('deletes only mismatched rows, applies the ordered policy CASE, and a second run changes nothing', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const unidx = await memory();
    const enc = await memory({ encrypted: true });
    const sys = await memory({ system: true });
    const gone = await memory({ indexed: true, deleted: true });

    const ids = {
      indexed: await node(idx, { tagged: src, markers: true }),
      mixed: await node(idx, { tagged: src, correctRows: true }),
      unindexedNull: await node(unidx, { tagged: src }),
      unindexedSet: await node(unidx, { tagged: src, markers: true }),
      system: await node(sys, { tagged: src }),
      rawChat: await node(idx, { tagged: src, markers: true, nodeType: 'chat-message' }),
      deletedMemory: await node(gone, { tagged: src, markers: true }),
      encrypted: await node(enc, { tagged: src, markers: true }),
      deleted: await node(idx, { tagged: src, markers: true, deleted: true }),
      deletedUnindexed: await node(unidx, { tagged: src, markers: true, deleted: true }),
      deletedEncrypted: await node(enc, { tagged: src, markers: true, deleted: true }),
      // Unaffected: correct rows only. The requeue-everything mutant changes its markers.
      correct: await node(idx, { markers: true }),
      sourceOwn: await node(src, { markers: true }),
    };
    const before = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await state(id)])));
    const start = new Date();

    await runFile();

    const after = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await state(id)])));
    for (const k of Object.keys(ids)) expect(untouched(after[k]), k).toEqual(untouched(before[k]));

    // Rows: every mismatched row is gone, every correct row stays.
    for (const k of Object.keys(ids)) {
      const home = after[k].memory_id;
      expect(after[k].rows.every((r: { memory_id: string }) => r.memory_id === home), k).toBe(true);
    }
    expect(after.mixed.rows).toEqual([{ memory_id: idx.id, kind: 'chunk', chunk_index: 7 }]);
    expect(after.correct.rows).toEqual(before.correct.rows);
    expect(after.sourceOwn.rows).toEqual(before.sourceOwn.rows);
    expect(after.indexed.rows).toEqual([]);

    // Markers, first match wins.
    expectRequeued(after.indexed, start);
    expectRequeued(after.mixed, start);
    expectRequeued(after.system, start); // #2199: a system memory is always indexed
    expect(after.indexed.token).not.toBe(after.mixed.token);
    expectCleared(after.unindexedNull);
    expectCleared(after.unindexedSet);
    expectCleared(after.rawChat);
    expectCleared(after.deletedMemory);
    for (const k of ['encrypted', 'deleted', 'deletedUnindexed', 'deletedEncrypted', 'correct', 'sourceOwn']) {
      expect(markers(after[k]), k).toEqual(markers(before[k]));
    }

    // Idempotent: nothing left to match.
    await runFile();
    for (const k of Object.keys(ids)) expect(await state(ids[k as keyof typeof ids]), k).toEqual(after[k]);
  });

  it('a writer holding the old work token, or the old memory, is refused afterwards', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    await runFile();
    const token = (await state(id)).token!;
    const row = { nodeId: id, provider: 'synthetic', model: 'synthetic', dim: 768, embedding: Array(768).fill(0.01) };
    expect(await upsertAbstractVector(db, { ...row, memoryId: idx.id }, OLD_TOKEN)).toBe(false);
    expect(await upsertAbstractVector(db, { ...row, memoryId: src.id }, token)).toBe(false);
    expect((await state(id)).rows).toEqual([]);
    expect(await upsertAbstractVector(db, { ...row, memoryId: idx.id }, token)).toBe(true);
  });
});

describe('#1997 scrub: the shipped SQL', () => {
  it('projects ids, memory identity, deleted_at, the raw-chat inputs and policy flags only', () => {
    const code = read().replace(/--.*$/gm, '');
    for (const column of ['content', 'abstract', 'data', 'chunk_text', 'embedding', 'properties']) {
      expect(code, column).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(code).toMatch(/RETURNING ne\.node_id\s*\)/);
    expect(code).not.toMatch(/post-push/);
  });

  it('uses the same raw-chat rule as the embed path', () => {
    expect(read()).toContain(`n.loc ~ '${RAW_CHAT_TURN_LOC_PATTERN}'`);
    expect(read()).toContain(`n.node_type = 'chat-message'`);
  });

  it('is split into the four steps the race pins drive, in lock order', () => {
    expect(steps().map((s) => s.name)).toEqual(['discover', 'lock-nodes', 'lock-memories', 'scrub']);
  });

  it('never waits for a row lock: both lock steps are NOWAIT, every other wait is bounded below deadlock_timeout', () => {
    const byName = Object.fromEntries(steps().map((s) => [s.name, s.sql]));
    expect(byName['lock-nodes']).toMatch(/FOR NO KEY UPDATE OF n NOWAIT;$/);
    expect(byName['lock-memories']).toMatch(/FOR SHARE OF m NOWAIT;$/);
    expect(read()).toMatch(/^SET LOCAL lock_timeout = '100ms';$/m);
    expect(read()).toMatch(/EXCEPTION WHEN lock_not_available OR deadlock_detected THEN/);
  });
});

describe('#1997 scrub: concurrency (both orders, no deadlock)', { timeout: 30_000 }, () => {
  /** A synthetic subtree move / merge fold: its Nodes FOR UPDATE, sorted, then its Memory rows, then the relocation. */
  async function relocate(nodeIds: string[], from: Mem, to: Mem, beforeMemories?: () => Promise<void>): Promise<void> {
    await db.$transaction(async (tx) => {
      for (const id of [...nodeIds].sort()) await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
      await beforeMemories?.();
      for (const m of [from.id, to.id].sort()) await tx.$queryRaw`SELECT id FROM memories WHERE id = ${m} FOR NO KEY UPDATE`;
      await tx.$executeRaw`UPDATE nodes SET memory_id = ${to.id} WHERE id = ANY(${nodeIds}::text[])`;
    }, { timeout: 30_000, maxWait: 10_000 });
  }

  it('a relocation committing between discovery and the locks is judged by where the node now is', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const unidx = await memory();
    const healed = await node(idx, { tagged: src, markers: true });
    const moved = await node(idx, { tagged: src, markers: true });
    const before = await state(healed);
    await runSteps({
      discover: async () => {
        await db.$executeRaw`UPDATE nodes SET memory_id = ${src.id} WHERE id = ${healed}`; // its rows now match
        await db.$executeRaw`UPDATE nodes SET memory_id = ${unidx.id} WHERE id = ${moved}`;
      },
    });
    const h = await state(healed);
    expect(h.rows).toHaveLength(3);
    expect(markers(h)).toEqual(markers(before)); // lost its last mismatch, so not affected
    const m = await state(moved);
    expect(m.rows).toEqual([]);
    expectCleared(m); // the post-move memory's policy
  });

  it('move first: the scrub yields on the Node, holding nothing, retries and sees the post-move state', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const unidx = await memory();
    const id = await node(idx, { tagged: src, markers: true });
    let scrub!: Promise<void>;
    await relocate([id], idx, unidx, async () => {
      scrub = runFile();
      await waitForScrubRetry(); // its NOWAIT met our Node lock
    });
    await scrub;
    const s = await state(id);
    expect(s.memory_id).toBe(unidx.id);
    expect(s.rows).toEqual([]);
    expectCleared(s);
  });

  it('scrub first: the move waits on the Node, then relocates the scrubbed node', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const unidx = await memory();
    const id = await node(idx, { tagged: src, markers: true });
    const start = new Date();
    let move!: Promise<void>;
    await runSteps({
      'lock-memories': async () => {
        move = relocate([id], idx, unidx);
        await waitForLockWaiters(db, 1);
      },
    });
    await move;
    const s = await state(id);
    expect(s.memory_id).toBe(unidx.id);
    expect(s.rows).toEqual([]);
    expectRequeued(s, start); // judged under idx, where it was when locked
  });

  it('an index toggle is not fenced by the Node locks alone; the scrub reads the flipped policy', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    await runSteps({
      'lock-nodes': async () => {
        await db.memory.update({ where: { id: idx.id }, data: { vectorIndexEnabled: false } }); // does not wait
      },
    });
    expectCleared(await state(id));
  });

  it('an index toggle after the Memory SHARE waits for COMMIT; the scrub used the policy it locked', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    const start = new Date();
    let flip!: Promise<unknown>;
    await runSteps({
      'lock-memories': async () => {
        flip = db.memory.update({ where: { id: idx.id }, data: { vectorIndexEnabled: false } }).then((m) => m); // a PrismaPromise runs only once observed
        await waitForLockWaiters(db, 1);
      },
    });
    await flip;
    expectRequeued(await state(id), start);
  });

  it('encryption conversion (Memory SHARE, then one Node FOR UPDATE) waits on the scrub without a cycle', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    let conversion!: Promise<void>;
    await runSteps({
      'lock-nodes': async () => {
        conversion = db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${idx.id} FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
        }, { timeout: 30_000, maxWait: 10_000 });
        await waitForLockWaiters(db, 1);
      },
    });
    await conversion;
    expect((await state(id)).rows).toEqual([]);
  });

  it('a writer holding the old token, queued behind the scrub, is refused once it gets the Node', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    let write!: Promise<boolean>;
    await runSteps({
      'lock-memories': async () => {
        write = upsertAbstractVector(db, {
          nodeId: id, memoryId: idx.id, provider: 'synthetic', model: 'synthetic', dim: 768, embedding: Array(768).fill(0.01),
        }, OLD_TOKEN);
        await waitForLockWaiters(db, 1);
      },
    });
    expect(await write).toBe(false);
    expect((await state(id)).rows).toEqual([]);
  });

  /** encryptMemory's initial flip: Memory FOR UPDATE, the flag, then the real approval cleanup on its Nodes. */
  async function flip(mem: Mem, beforeNodes?: () => Promise<void>): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${mem.id} FOR UPDATE`;
      await tx.memory.update({ where: { id: mem.id }, data: { isEncrypted: true, vectorIndexEncryptedAckAt: new Date() } });
      await beforeNodes?.();
      await endApprovalsOnEncryptedEntry(tx, { memoryId: mem.id });
    }, { timeout: 30_000, maxWait: 10_000 });
  }

  async function approve(id: string): Promise<void> {
    await db.node.update({
      where: { id }, data: { approvedRevNo: 1, approvedAt: new Date(), approvedByInfo: 'synthetic-reviewer', approvalHash: 'synthetic' },
    });
  }

  it('encryption flip first (Memory, then an approved Node): the scrub yields, the flip commits, no 40P01', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    await approve(id);
    const before = await state(id);
    let scrub!: Promise<void>;
    await flip(idx, async () => {
      scrub = runFile();
      await waitForScrubRetry(); // it took the Node, met our Memory, and let the Node go
    });
    await scrub;
    const s = await state(id);
    expect(s.rows).toEqual([]);
    expect(markers(s)).toEqual(markers(before)); // judged under the now-encrypted memory
    expect((await db.node.findUniqueOrThrow({ where: { id } })).approvalHash).toBeNull();
  });

  it('scrub holding Nodes when a flip takes the Memory: the Memory step fails at once (55P03), freeing the flip', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    await approve(id);
    let flipping!: Promise<void>;
    const attempt = runSteps({
      'lock-nodes': async () => {
        flipping = flip(idx);
        await waitForLockWaiters(db, 1); // the flip holds the Memory and waits on our Node
      },
    }).then(() => undefined, (e: unknown) => e);
    const err = await attempt;
    expect(sqlstate(err)).toBe('55P03'); // not 40P01, and not a wait
    await flipping; // our rollback released the Node
    await runFile(); // the next attempt finds the memory free
    expect((await state(id)).rows).toEqual([]);
    expect((await db.memory.findUniqueOrThrow({ where: { id: idx.id } })).isEncrypted).toBe(true);
  });

  it('retryFailedEmbeddings first (Memory FOR UPDATE, then UPDATE nodes): the scrub yields, the restamp commits', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    let scrub!: Promise<void>;
    let restamped = -1;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${idx.id} FOR UPDATE`;
      scrub = runFile();
      await waitForScrubRetry();
      restamped = await restampFailedEmbeddings(tx, idx.id);
    }, { timeout: 30_000, maxWait: 10_000 });
    await scrub;
    expect(restamped).toBe(1);
    const s = await state(id);
    expect(s.rows).toEqual([]);
    expect(s.token).not.toBe(OLD_TOKEN);
  });

  it('a lock held past every attempt stops the file loudly and changes nothing', async () => {
    const src = await memory();
    const idx = await memory({ indexed: true });
    const id = await node(idx, { tagged: src, markers: true });
    const before = await state(id);
    let failure: unknown;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
      failure = await runFile({ attempts: 3 }).then(() => undefined, (e: unknown) => e);
    }, { timeout: 30_000, maxWait: 10_000 });
    expect(String((failure as { stderr?: string })?.stderr ?? failure)).toContain('rows stayed locked through 3 attempts');
    expect(await state(id)).toEqual(before);
  });
});
