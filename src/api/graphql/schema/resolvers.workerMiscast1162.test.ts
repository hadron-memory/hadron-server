/** #1162: empty ended stints are repairable; persisted attribution is not. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
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
});

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
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${worker.id} FOR UPDATE`;
      locked();
      await releasePromise;
    }, { timeout: 20_000 });
    await lockedPromise;
    const deletion = remove(worker.id).then(() => 'deleted', () => 'refused');
    try {
      await waitForLockWaiters(db as any);
      await db.node.create({ data: {
        id: generateId(), memoryId: otherMemoryId, loc: 'first-reference', name: 'First work',
        createdByWorkerId: worker.id,
      } });
    } finally { release(); }
    await holder;
    expect(await deletion).toBe('refused');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
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
