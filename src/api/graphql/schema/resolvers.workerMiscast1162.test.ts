/** #1162: empty ended stints are repairable; persisted attribution is not. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
let ctx: Context;
let appId: string;
let agentId: string;
let otherMemoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Repair', urn: 'repair1162.com' } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 116200, githubUsername: 'repair1162' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, userId: user.id, roles: ['READER'] };
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Repair role' }, ctx);
  agentId = agent.id;
  otherMemoryId = agent.systemMemoryId;
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Repair team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveEveryAgent(db); // #2712: binds need a served prompt
});

afterEach(() => sessionKeyCache.clear());

const cast = () => M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Miscast' }, ctx);
// Proposed input under scope review. This fixture explicitly attests synthetic
// identity has never appeared outside this isolated test DB. No crawler claim.
const remove = (workerRef: string) => M.deleteWorker({}, { workerRef, confirmNoExternalAttribution: true }, ctx);

describe('#1162 never-referenced repair', () => {
  it('normally ends an empty bound stint, then removes it without dangling sessions', async () => {
    const worker = await cast();
    const session = await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: worker.id, tool: 'test' } }, ctx);
    await M.endSession({}, { id: session.id }, ctx);
    await M.releaseWorker({}, { workerRef: worker.id }, ctx);
    expect(await remove(worker.id)).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await db.memory.findUnique({ where: { id: worker.memoryId } })).toBeNull();
  });

  it('MCP exposes the same empty-stint repair gate', async () => {
    const worker = await cast();
    const session = await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: worker.id, tool: 'test' } }, ctx);
    await M.endSession({}, { id: session.id }, ctx);
    await M.releaseWorker({}, { workerRef: worker.id }, ctx);
    const text = await createTestableMcpServer({ userId: ctx.userId, roles: ['READER'] }).callToolText(
      'hadron_delete_worker', { workerRef: worker.id, confirmNoExternalAttribution: true },
    );
    expect(text).not.toMatch(/error|WORKER_IN_USE/i);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
  });

  it('keeps an open binding in use', async () => {
    const worker = await cast();
    await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: worker.id, tool: 'test' } }, ctx);
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });

  it('MCP reports omitted and false external confirmation as errors', async () => {
    const worker = await cast();
    for (const confirmation of [undefined, false]) {
      const result = await createTestableMcpServer({ userId: ctx.userId, roles: ['READER'] }).callTool(
        'hadron_delete_worker', { workerRef: worker.id, confirmNoExternalAttribution: confirmation },
      );
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(result)).toContain('WORKER_EXTERNAL_ATTRIBUTION_UNCONFIRMED');
      expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    }
  });

  it('a never-bound verified-empty casting remains removable', async () => {
    const worker = await cast();
    expect(await remove(worker.id)).toBe(true);
    expect(await cast()).toMatchObject({ name: 'Miscast' });
  });

  it('does not erase a first no-FK reference committed while deletion waits', async () => {
    const worker = await cast();
    let release!: () => void;
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${worker.id} FOR KEY SHARE`;
      locked();
      await releasePromise;
    }, { timeout: 20_000 });
    await lockedPromise;
    const deletion = remove(worker.id).then(() => 'deleted', (error: unknown) => (error as { extensions?: { code?: string } }).extensions?.code ?? 'unexpected');
    try {
      await waitForLockWaiters(db as any);
      await db.node.create({ data: {
        id: generateId(), memoryId: otherMemoryId, loc: 'first-reference', name: 'First work',
        createdByWorkerId: worker.id,
      } });
    } finally { release(); }
    await holder;
    expect(await deletion).toBe('WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
  });

  it('refuses a REPEATABLE READ first reference after its snapshot Worker is deleted', async () => {
    const worker = await cast();
    const nodeId = generateId();
    let snapshotReady!: () => void;
    let write!: () => void;
    const ready = new Promise<void>(resolve => { snapshotReady = resolve; });
    const proceed = new Promise<void>(resolve => { write = resolve; });
    const writer = db.$transaction(async tx => {
      // Establish an old snapshot without taking a Worker-row lock.
      expect(await tx.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
      snapshotReady();
      await proceed;
      await tx.node.create({ data: {
        id: nodeId, memoryId: otherMemoryId, loc: 'stale-snapshot', name: 'Stale writer',
        createdByWorkerId: worker.id,
      } });
    }, { isolationLevel: 'RepeatableRead', timeout: 20_000 }).then(
      () => 'committed', (error: unknown) => (error as { code?: string }).code ?? 'unexpected',
    );
    await ready;
    try {
      expect(await remove(worker.id)).toBe(true);
      expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    } finally { write(); }
    expect(await writer).toBe('P2034');
    expect(await db.node.findUnique({ where: { id: nodeId } })).toBeNull();
  });

  it('returns a typed rejection naming the missing Worker and writer', async () => {
    const missing = generateId();
    await expect(db.node.create({ data: {
      id: generateId(), memoryId: otherMemoryId, loc: 'dangling', name: 'Dangling', createdByWorkerId: missing,
    } })).rejects.toMatchObject({ extensions: {
      code: 'WORKER_REFERENCE_NOT_FOUND', workerRef: missing, writer: 'nodes', referenceKind: 'worker',
    } });
  });

  it('keeps legacy dangling attribution unchanged during an import upsert', async () => {
    const missing = generateId();
    const nodeId = generateId();
    // Simulate a row predating this migration, on this test's private DB only.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE nodes DISABLE TRIGGER worker_reference_fence_1162');
      await tx.node.create({ data: { id: nodeId, memoryId: otherMemoryId, loc: 'legacy', name: 'Legacy', createdByWorkerId: missing } });
      await tx.$executeRawUnsafe('ALTER TABLE nodes ENABLE TRIGGER worker_reference_fence_1162');
    });
    const kept = await db.node.upsert({ where: { id: nodeId },
      create: { id: nodeId, memoryId: otherMemoryId, loc: 'legacy', name: 'Imported', createdByWorkerId: missing },
      update: { name: 'Imported', createdByWorkerId: missing },
    });
    expect(kept.createdByWorkerId).toBe(missing);
    const worker = await cast();
    const imported = await db.node.create({ data: { id: generateId(), memoryId: otherMemoryId, loc: 'imported', name: 'Imported', createdByWorkerId: worker.id } });
    expect(imported.createdByWorkerId).toBe(worker.id);
  });

  for (const kind of ['chat', 'worklog', 'memory', 'bind'] as const) {
    it(`fences a first ${kind} reference committed while deletion waits`, async () => {
      const worker = await cast();
      let release!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => { locked = resolve; });
      const done = new Promise<void>((resolve) => { release = resolve; });
      const holder = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${worker.id} FOR KEY SHARE`;
        locked(); await done;
      }, { timeout: 20_000 });
      await ready;
      const deletion = remove(worker.id).then(() => 'deleted', (error: unknown) => (error as { extensions?: { code?: string } }).extensions?.code ?? 'unexpected');
      try {
        await waitForLockWaiters(db as any);
        if (kind === 'bind') {
          await db.session.create({ data: { id: generateId(), appId, workerId: worker.id } });
        } else {
          await db.node.create({ data: {
            id: generateId(), memoryId: kind === 'memory' ? worker.memoryId : otherMemoryId,
            loc: 'racing', name: 'Racing reference',
            ...(kind === 'chat' ? { data: { authorWorkerId: worker.id } } : {}),
            ...(kind === 'worklog' ? { properties: { workerId: worker.id } } : {}),
          } });
        }
      } finally { release(); }
      await holder;
      expect(await deletion).toBe('WORKER_IN_USE');
      expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    });
  }

  it('rejects a first reference whose Worker was deleted while the writer waited', async () => {
    const worker = await cast();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const done = new Promise<void>((resolve) => { release = resolve; });
    // Stage the winning delete transaction at the same two locks the resolver
    // takes; actual PostgreSQL triggers and the waiting publisher remain live.
    const deletion = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${worker.id} FOR UPDATE`;
      await tx.$executeRaw`INSERT INTO worker_reference_fences(subject_id) VALUES (${worker.id})
        ON CONFLICT (subject_id) DO UPDATE SET version = worker_reference_fences.version + 1`;
      locked(); await done;
      await tx.worker.delete({ where: { id: worker.id } });
    }, { timeout: 20_000 });
    await ready;
    const publication = db.node.create({ data: {
      id: generateId(), memoryId: otherMemoryId, loc: 'late-publication', name: 'Late work', createdByWorkerId: worker.id,
    } }).then(() => null, (error: unknown) => error);
    try { await waitForLockWaiters(db as any); } finally { release(); }
    await deletion;
    expect(await publication).toMatchObject({ extensions: { code: 'WORKER_REFERENCE_NOT_FOUND', workerRef: worker.id, writer: 'nodes' } });
    expect(await db.node.count({ where: { memoryId: otherMemoryId, loc: 'late-publication' } })).toBe(0);
  });

  it('preserves authored revision history outside the working memory', async () => {
    const worker = await cast();
    const node = await db.node.create({ data: { memoryId: otherMemoryId, loc: 'revised', name: 'Revised' } });
    await db.nodeRevision.create({ data: {
      nodeId: node.id, memoryId: otherMemoryId, loc: node.loc, name: node.name,
      tags: [], changes: [], editedByWorkerId: worker.id,
    } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });

  it('preserves tombstoned assets in working memory', async () => {
    const worker = await cast();
    await db.asset.create({ data: {
      memoryId: worker.memoryId, filename: 'work.txt', mimeType: 'text/plain', sizeBytes: 1,
      storageKey: generateId(), deletedAt: new Date(),
    } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });

  it('preserves a known PR attribution on an ended released session despite confirmation', async () => {
    const worker = await cast();
    const session = await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: worker.id, tool: 'test' } }, ctx);
    await db.session.update({ where: { id: session.id }, data: { prNumber: 1162 } });
    await M.endSession({}, { id: session.id }, ctx);
    await M.releaseWorker({}, { workerRef: worker.id }, ctx);
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });

  it('refuses unreadable legacy ciphertext and checks it when an existing key is present', async () => {
    const worker = await cast();
    const key = generateDataKey();
    const data = encryptNodeFieldsWithKey({ data: { authorWorkerId: worker.id } }, key).data;
    await db.node.create({ data: { memoryId: otherMemoryId, loc: 'legacy-cipher', name: 'Legacy', data: data as never } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
    sessionKeyCache.set('legacy-test-key', otherMemoryId, key);
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });

  it('does not count readable ciphertext belonging only to another identity as this Worker use', async () => {
    const worker = await cast();
    const other = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Other' }, ctx);
    const key = generateDataKey();
    const data = encryptNodeFieldsWithKey({ data: { authorWorkerId: other.id } }, key).data;
    await db.node.create({ data: { memoryId: otherMemoryId, loc: 'other-cipher', name: 'Other', data: data as never } });
    sessionKeyCache.set('other-test-key', otherMemoryId, key);
    expect(await remove(worker.id)).toBe(true);
  });

  it('preserves encrypted cross-App chat authored by an explicit sessionRef without ambient attribution', async () => {
    const sourceApp = await db.app.findUniqueOrThrow({ where: { id: appId } });
    const other = await db.app.create({ data: { organizationId: sourceApp.organizationId, name: 'Other team', urn: 'repair1162.com:encrypted' } });
    await db.appAgent.create({ data: { appId: other.id, agentId } });
    await M.createTeamChatMessage({}, { appRef: other.id, body: 'Human setup' }, ctx);
    const root = await db.node.findFirstOrThrow({
      // loc-scope-ok: the fixture App and class scope this chat root.
      where: { loc: 'chats:team', memory: { appId: other.id, class: 'app' } },
    });
    sessionKeyCache.set('repair-cipher-key', root.memoryId, generateDataKey());
    await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
    const worker = await cast();
    const session = await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: worker.id, tool: 'test' } }, ctx);
    const message = await M.createTeamChatMessage({}, { appRef: other.id, body: 'Encrypted authored work', sessionRef: session.id }, ctx);
    await M.endSession({}, { id: session.id }, ctx);
    await M.releaseWorker({}, { workerRef: worker.id }, ctx);
    sessionKeyCache.clear(); // new explicit stamps protect even when the body is locked
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: message.nodeId } })).createdByWorkerId).toBe(worker.id);
  });

  for (const field of ['createdByWorkerId', 'updatedByWorkerId'] as const) {
    it(`preserves a tombstoned node outside working memory attributed by ${field}`, async () => {
      const worker = await cast();
      const node = await db.node.create({ data: {
        id: generateId(), memoryId: otherMemoryId, loc: 'history', name: 'Historical work',
        [field]: worker.id, deletedAt: new Date(),
      } });
      await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
      expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
      expect(await db.node.findUnique({ where: { id: node.id } })).not.toBeNull();
    });
  }

  for (const [label, column, key] of [
    ['cross-App chat authorship', 'data', 'authorWorkerId'],
    ['worklog artifact', 'properties', 'workerId'],
  ] as const) {
    it(`preserves a tombstoned ${label} by immutable id without a session proxy`, async () => {
      const worker = await cast();
      const foreignApp = await db.app.create({ data: {
        id: generateId(), organizationId: (await db.app.findUniqueOrThrow({ where: { id: appId } })).organizationId,
        name: 'Other team', urn: 'repair1162.com:other',
      } });
      const memory = await db.memory.create({ data: {
        id: generateId(), urn: 'repair1162.com:other-history', name: 'Other history',
        class: 'app', appId: foreignApp.id,
        organizationId: foreignApp.organizationId,
      } });
      await db.node.create({ data: {
        id: generateId(), memoryId: memory.id, loc: 'preserved', name: 'Preserved attribution',
        [column]: { [key]: worker.id }, deletedAt: new Date(),
      } });
      await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
      expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    });
  }

  it('preserves an append-only task event naming the worker even after assignment moved', async () => {
    const worker = await cast();
    await db.agentTeamEvent.create({ data: {
      id: generateId(), appId, type: 'task.assigned', actorUserId: ctx.userId,
      subjectWorkerId: worker.id, payload: {},
    } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });

  it('does not treat omitted external-history confirmation as verified absence', async () => {
    const worker = await cast();
    await expect(M.deleteWorker({}, { workerRef: worker.id }, ctx)).rejects.toBeDefined();
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
  });
});
