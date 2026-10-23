import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { stampEmbeddingObligation, resetEmbeddingObligations, FRESH_PLAINTEXT_REQUIRED } from './obligation.js';
import { upsertAbstractVector, deleteNodeVectors, deleteMemoryVectors } from './vectors.js';
import { readFileSync } from 'node:fs';
import { embedNode, embeddingDispatcher, handleEmbedWake, assertEmbeddingObligationsReconciled } from '../../jobs/embedNodes.js';
import { cloneMemoryGraph } from '../../controller/operations/cloneMemory.js';
import { enqueueNodeEmbedding, backfillMemoryEmbeddings, restampFailedEmbeddings } from './enqueue.js';
import { EmbeddingRequestError, setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../lib/embedding/index.js';
import { generateDataKey, parseDataKey } from '../../lib/crypto.js';
import * as bus from '../../lib/bus/index.js';
import { emptyActor, publishUser, requestActorStorage } from '../../lib/requestActor.js';
import { encryptNodeFieldsWithKey } from '../../lib/nodeCrypto.js';

let memoryId: string;
let nodeId: string;
const stamp = () => db.$transaction(tx => stampEmbeddingObligation(tx, nodeId, memoryId));
const vector = () => ({
  nodeId, memoryId, provider: 'synthetic', model: 'internal4', dim: 768,
  embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0),
});

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'obligation-org', graphName: 'obligation/test' });
  memoryId = made.graph.id;
  await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true } });
  nodeId = generateId();
  await db.node.create({ data: { id: nodeId, memoryId, loc: 'target', name: 'synthetic' } });
});
afterEach(() => vi.useRealTimers());

describe('internal#4 durable obligation ownership (real private DB)', () => {
  it('client wrappers cannot multiply the process-wide dispatcher capacity', () => {
    const dispatcher = embeddingDispatcher(db);
    expect(embeddingDispatcher(new Proxy(db, {}))).toBe(dispatcher);
  });
  it.each([false, true])('clone commits its obligations before any resolver backfill (indexed=%s)', async indexed => {
    const memory = await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: indexed } });
    const sourceToken = await stamp();
    const cloned = await cloneMemoryGraph(db, {
      sourceMemoryId: memoryId, name: 'clone', newUrn: `${memory.organizationId}:synthetic-clone`,
      targetOrganizationId: memory.organizationId!, ownerUserId: null, groupOwnerUserId: null, actorId: null,
      copierReadableMemoryIds: null, // unrestricted synthetic fixture; production supplies the caller's readable set
    });
    const nodes = await db.node.findMany({ where: { memoryId: cloned.memoryId } });
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      if (indexed) {
        expect(node.embeddingWorkToken).toMatch(/^[0-9a-f-]{36}$/);
        expect(node.embeddingWorkToken).not.toBe(sourceToken);
        expect(node.embeddingPendingAt).not.toBeNull();
      } else {
        expect(node.embeddingWorkToken).toBeNull();
        expect(node.embeddingPendingAt).toBeNull();
      }
    }
  });

  it('operational SQL backfill, retry and batch reset preserve the last authored user and content', async () => {
    const writer = await db.user.create({ data: { id: generateId(), handle: `writer-${generateId()}`, name: 'writer' } });
    const operator = await db.user.create({ data: { id: generateId(), handle: `operator-${generateId()}`, name: 'operator' } });
    await requestActorStorage.run(emptyActor(), async () => {
      publishUser(writer.id);
      await db.node.update({ where: { id: nodeId }, data: { content: 'authored content', abstract: 'authored summary' } });
    });
    const before = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    await requestActorStorage.run(emptyActor(), async () => {
      publishUser(operator.id);
      for (const reset of [
        () => backfillMemoryEmbeddings(db, memoryId),
        () => restampFailedEmbeddings(db, memoryId),
        () => db.$transaction(tx => resetEmbeddingObligations(tx, [nodeId], true)),
      ]) {
        await db.$executeRaw`UPDATE nodes SET embedding_failed_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE id = ${nodeId}`;
        await reset();
        const after = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
        expect(after.embeddingWorkToken).toBeTypeOf('string');
        expect(after.updatedByUserId).toBe(writer.id);
        expect(after.updatedByWorkerId).toBe(before.updatedByWorkerId);
        expect(after.updatedByAgentId).toBe(before.updatedByAgentId);
        expect(after.content).toBe(before.content);
        expect(after.abstract).toBe(before.abstract);
        expect(after.updatedAt).toEqual(before.updatedAt);
      }
    });
  });

  it('the migration backfills runnable work, preserves backoff and leaves terminal/cancelled work alone', async () => {
    const sql = readFileSync(new URL('../../../prisma/migrations/20261021190000_embedding_work_tokens/migration.sql', import.meta.url), 'utf8');
    await db.$transaction(async tx => {
      // Connection-local tables shadow the production names. No real schema or rows are changed.
      await tx.$executeRawUnsafe("CREATE TEMP TABLE memories (id text, deleted_at timestamp, vector_index_enabled boolean, class text DEFAULT 'knowledge') ON COMMIT DROP");
      await tx.$executeRawUnsafe('CREATE TEMP TABLE nodes (id text, memory_id text, embedding_pending_at timestamp, deleted_at timestamp, embedding_failed_at timestamp, embedding_attempts int, embedding_error text) ON COMMIT DROP');
      await tx.$executeRawUnsafe("INSERT INTO memories (id, deleted_at, vector_index_enabled) VALUES ('indexed', NULL, true), ('off', NULL, false)");
      await tx.$executeRawUnsafe("INSERT INTO memories VALUES ('system', NULL, false, 'system')");
      await tx.$executeRawUnsafe(`INSERT INTO nodes VALUES
        ('due', 'indexed', '2026-01-01', NULL, NULL, 0, NULL),
        ('system-due', 'system', '2026-01-01', NULL, NULL, 0, NULL),
        ('backoff', 'indexed', '2099-01-01', NULL, '2026-01-01', 9, 'synthetic retry'),
        ('idle', 'indexed', NULL, NULL, NULL, 0, NULL),
        ('terminal', 'indexed', NULL, NULL, '2026-01-01', 1, 'synthetic terminal'),
        ('deleted', 'indexed', '2026-01-01', '2026-01-01', NULL, 0, NULL),
        ('disabled', 'off', '2026-01-01', NULL, NULL, 0, NULL)`);
      const before = await tx.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM nodes ORDER BY id');
      for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) {
        await tx.$executeRawUnsafe(statement);
      }
      const after = await tx.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM nodes ORDER BY id /* after additive migration */');
      for (let i = 0; i < after.length; i++) {
        const { embedding_work_token: token, ...rest } = after[i];
        expect(rest).toEqual(before[i]);
        if (['due', 'backoff', 'system-due'].includes(rest.id as string)) {
          expect(token).toBeTypeOf('string');
          expect(token).toMatch(/^[0-9a-f-]{36}$/);
        }
        else expect(token).toBeNull();
      }
      expect(after.find(row => row.id === 'due')!.embedding_work_token)
        .not.toBe(after.find(row => row.id === 'backoff')!.embedding_work_token);
    });
  });

  it('different accepted writes get different identities even with an identical clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T18:00:00Z'));
    const a = await stamp();
    const before = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const b = await stamp();
    const after = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
    expect(after.embeddingPendingAt).toEqual(before.embeddingPendingAt);
    expect(after.embeddingWorkToken).toBe(b);
  });

  it('stale SQL writers and deletes cannot overwrite or remove the newer vector', async () => {
    const a = (await stamp())!;
    const b = (await stamp())!;
    expect(await upsertAbstractVector(db, vector(), a)).toBe(false);
    expect(await upsertAbstractVector(db, vector(), b)).toBe(true);
    await deleteNodeVectors(db, nodeId, a);
    const rows = await db.$queryRaw<{ model: string }[]>`
      SELECT model FROM node_embeddings WHERE node_id = ${nodeId}`;
    expect(rows).toEqual([{ model: 'internal4' }]);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).embeddingWorkToken).toBe(b);
  });

  it('memory vector cancellation invalidates a captured token before an old worker can reinsert', async () => {
    const captured = (await stamp())!;
    expect(await upsertAbstractVector(db, vector(), captured)).toBe(true);
    await deleteMemoryVectors(db, memoryId);
    expect(await upsertAbstractVector(db, vector(), captured)).toBe(false);
    const row = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(row.embeddingWorkToken).toBeNull();
    expect(row.embeddingPendingAt).toBeNull();
    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM node_embeddings WHERE memory_id = ${memoryId}`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it.each(['success', 'transient', 'permanent'] as const)('a newer commit owns persistence after a held endpoint returns %s', async outcome => {
    await db.node.update({ where: { id: nodeId }, data: { abstract: 'synthetic A' } });
    const a = (await stamp())!;
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const client = {
      provider: 'synthetic', model: 'internal4', dim: 768,
      embed: vi.fn(async () => {
        started(); await held;
        if (outcome === 'transient') throw new Error('synthetic transient');
        if (outcome === 'permanent') throw new EmbeddingRequestError('synthetic permanent', { retryable: false });
        return [vector().embedding];
      }),
    };
    const attempt = embedNode(db, nodeId, { abstract: 'synthetic A' }, client, { workToken: a });
    let b: string | null = null;
    try {
      await reached;
      b = await db.$transaction(async tx => {
        await tx.node.update({ where: { id: nodeId }, data: { abstract: 'synthetic B' } });
        return stampEmbeddingObligation(tx, nodeId, memoryId);
      });
    } finally { release(); }
    expect(await attempt).toBe(outcome === 'success' ? 'skipped' : `failed-${outcome}`);
    expect(client.embed).toHaveBeenCalledTimes(1);
    const row = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(row.embeddingWorkToken).toBe(b);
    expect(row.embeddingPendingAt).not.toBeNull();
    expect(row.embeddingFailedAt).toBeNull();
    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM node_embeddings WHERE node_id = ${nodeId}`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a rolled-back writer cannot publish a durable replacement obligation', async () => {
    const a = await stamp();
    await expect(db.$transaction(async tx => {
      await tx.node.update({ where: { id: nodeId }, data: { abstract: 'rolled back' } });
      await stampEmbeddingObligation(tx, nodeId, memoryId);
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    const row = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(row.embeddingWorkToken).toBe(a);
    expect(row.abstract).toBeNull();
  });

  it.each([false, true])('idle enqueue admits adjacent prompts up to both slots without its own recovery wake (encrypted=%s)', async encrypted => {
    const key = parseDataKey(generateDataKey().raw.toString('base64'));
    const plaintext = { abstract: 'synthetic authorized summary' };
    const stored = encrypted ? encryptNodeFieldsWithKey(plaintext, key) : plaintext;
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: encrypted, vectorIndexEncryptedAckAt: encrypted ? new Date() : null } });
    await db.node.update({ where: { id: nodeId }, data: { abstract: stored.abstract } });
    const other = await db.node.create({ data: { id: generateId(), memoryId, loc: 'adjacent', name: 'synthetic', abstract: stored.abstract } });
    const ids = [nodeId, other.id];
    const tokens = await Promise.all(ids.map(id => db.$transaction(tx => stampEmbeddingObligation(tx, id, memoryId))));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const dispatcher = embeddingDispatcher(db);
    const client = { provider: 'synthetic', model: 'internal4', dim: 768, embed: vi.fn(async () => { await held; return [vector().embedding]; }) };
    setEmbeddingClientForTests(client);
    vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid');
    try {
      await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false }));
      // Both enqueue bodies execute in the same turn, before either endpoint retires.
      await Promise.all(ids.map((id, i) => enqueueNodeEmbedding(db, { nodeId: id, memoryId, workToken: tokens[i], plaintext })));
      expect(dispatcher.state()).toMatchObject({ active: 2, selecting: false, scheduled: false, dirty: false, queued: 0 });
      await vi.waitFor(() => expect(client.embed).toHaveBeenCalledTimes(2));
      expect(dispatcher.state()).toMatchObject({ active: 2, queued: 0 });
      release();
      await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false }));
      // Further isolated accepted writes are not suppressed after the prior drain settles.
      for (const id of ids) {
        const token = await db.$transaction(tx => stampEmbeddingObligation(tx, id, memoryId));
        await enqueueNodeEmbedding(db, { nodeId: id, memoryId, workToken: token, plaintext });
        await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false }));
        expect((await db.node.findUniqueOrThrow({ where: { id } })).embeddingWorkToken).toBeNull();
      }
      expect(client.embed).toHaveBeenCalledTimes(4);
    } finally {
      release();
      await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false }));
      resetEmbeddingClientForTests(); vi.unstubAllEnvs();
    }
  });

  it('an admitted encrypted prompt emits no bus echo, while rejected overflow still wakes the subscriber', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, vectorIndexEncryptedAckAt: new Date() } });
    const ids = [nodeId];
    for (let i = 1; i < 3; i++) ids.push((await db.node.create({ data: { id: generateId(), memoryId, loc: `bus-adjacent-${i}`, name: 'synthetic' } })).id);
    const tokens = await Promise.all(ids.map(id => db.$transaction(tx => stampEmbeddingObligation(tx, id, memoryId))));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const dispatcher = embeddingDispatcher(db);
    const client = { provider: 'synthetic', model: 'internal4', dim: 768, embed: vi.fn(async () => { await held; return [vector().embedding]; }) };
    const publish = vi.fn(async (_subject: string, payload: unknown, _opts?: bus.BusPublishOpts) => { await handleEmbedWake(db, payload); });
    const busLookup = vi.spyOn(bus, 'getBusClient').mockResolvedValue({
      publish, subscribeQueue: vi.fn(async () => async () => {}), subscribePubSub: vi.fn(async () => async () => {}),
      requestReply: vi.fn(async () => null), close: vi.fn(async () => {}),
    });
    setEmbeddingClientForTests(client);
    vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid');
    const offer = (i: number) => enqueueNodeEmbedding(db, { nodeId: ids[i], memoryId, workToken: tokens[i], plaintext: { abstract: 'synthetic authorized text' } });
    try {
      await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false }));
      await offer(0);
      // Deliver any self-published wake through the actual subscriber before B,
      // without yielding to setImmediate (the hostile same-process queue delivery).
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
      await offer(1);
      expect(dispatcher.state()).toMatchObject({ active: 2, dirty: false, scheduled: false, selecting: false });
      expect(publish).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(client.embed).toHaveBeenCalledTimes(2));
      await offer(2); // actual saturation still publishes recovery, echoing via handleEmbedWake
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
      expect(publish.mock.calls[0]).toEqual(['embed.wake.v1', {} , expect.anything()]);
      expect(dispatcher.state()).toMatchObject({ active: 2, dirty: true, queued: 0 });
      expect(client.embed).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false }));
      busLookup.mockRestore(); resetEmbeddingClientForTests(); vi.unstubAllEnvs();
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: ids[2] } })).embeddingWorkToken).toBe(tokens[2]);
    expect(client.embed).toHaveBeenCalledTimes(2); // rejected plaintext was never retained
  });

  it('encrypted overflow retains only its durable obligation, without an enqueue DB/provider fan-out', async () => {
    const key = parseDataKey(generateDataKey().raw.toString('base64'));
    const encrypted = encryptNodeFieldsWithKey({ abstract: 'synthetic confidential text' }, key);
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, vectorIndexEncryptedAckAt: new Date() } });
    await db.node.update({ where: { id: nodeId }, data: { abstract: encrypted.abstract } });
    const workToken = await stamp();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const dispatcher = embeddingDispatcher(db);
    const client = { provider: 'synthetic', model: 'internal4', dim: 768, embed: vi.fn(async () => [vector().embedding]) };
    setEmbeddingClientForTests(client);
    vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid');
    const query = vi.spyOn(db.node, 'findUnique');
    try {
      expect(dispatcher.tryRun('held-a', () => held)).toBe(true);
      expect(dispatcher.tryRun('held-b', () => held)).toBe(true);
      await enqueueNodeEmbedding(db, { nodeId, memoryId, workToken, plaintext: { abstract: 'synthetic confidential text' } });
      expect(query).not.toHaveBeenCalled();
      expect(client.embed).not.toHaveBeenCalled();
      expect(dispatcher.state()).toMatchObject({ active: 2, queued: 0 });
      const row = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
      expect(row.embeddingWorkToken).toBe(workToken);
      expect(row.embeddingError).toBe(FRESH_PLAINTEXT_REQUIRED);
      expect(row.embeddingPendingAt).not.toBeNull();
      expect(row.abstract).toBe(encrypted.abstract);
    } finally {
      query.mockRestore();
      release();
      await vi.waitFor(() => expect(dispatcher.state()).toMatchObject({ active: 0, selecting: false, scheduled: false }));
      resetEmbeddingClientForTests();
      vi.unstubAllEnvs();
    }
    expect(client.embed).not.toHaveBeenCalled(); // freeing a slot never resurrects rejected plaintext
  });

  it.each([[true, true], [false, true], [true, false]])('batch resets use the parent encryption state for their remedy (encrypted=%s,indexed=%s)', async (encrypted, indexed) => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: encrypted, vectorIndexEncryptedAckAt: encrypted ? new Date() : null } });
    await db.$transaction(tx => resetEmbeddingObligations(tx, [nodeId], indexed));
    const row = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(row.embeddingError).toBe(encrypted && indexed ? FRESH_PLAINTEXT_REQUIRED : null);
    if (indexed) {
      expect(row.embeddingWorkToken).toBeTypeOf('string');
      expect(row.embeddingPendingAt).not.toBeNull();
    } else {
      expect(row.embeddingWorkToken).toBeNull();
      expect(row.embeddingPendingAt).toBeNull();
    }
  });

  it('an encrypted transient failure keeps the fresh-plaintext remedy on its rotated obligation', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, vectorIndexEncryptedAckAt: new Date() } });
    const captured = (await stamp())!;
    const client = {
      provider: 'synthetic', model: 'internal4', dim: 768,
      embed: vi.fn(async () => { throw new Error('synthetic endpoint unavailable'); }),
    };
    expect(await embedNode(db, nodeId, { abstract: 'authorized synthetic plaintext' }, client, { workToken: captured }))
      .toBe('failed-transient');
    const row = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(row.embeddingWorkToken).not.toBe(captured);
    expect(row.embeddingWorkToken).toBeTypeOf('string');
    expect(row.embeddingPendingAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.embeddingError).toBe(FRESH_PLAINTEXT_REQUIRED);
    expect(await embedNode(db, nodeId, undefined, client)).toBe('skipped');
    expect(client.embed).toHaveBeenCalledTimes(1);
  });

  it('startup closes admission on an unreconciled runnable null-token obligation', async () => {
    await db.node.update({ where: { id: nodeId }, data: { embeddingPendingAt: new Date(), embeddingWorkToken: null } });
    await expect(assertEmbeddingObligationsReconciled(db)).rejects.toThrow('unreconciled legacy obligations');
    const work = vi.fn(async () => {});
    expect(embeddingDispatcher(db).tryRun(nodeId, work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
  });
});
