/**
 * #4312 (cor:dmo:050:11, cor:agt:020:02): retirement's own ticker bookkeeping (soft-deleting the generated tickers,
 * ending the subscriptions to them) is not use of the worker, so a retired never-used casting whose Agent has ticker
 * templates is still removable by `worker rm`. The refusal controls (an edited generated ticker, a subscription
 * another worker holds, a delivered tick) still refuse after retirement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
let ctx: Context;
let appId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Retired tick', urn: 'retiredtick4312.com' } });
  const admin = await db.user.create({ data: { id: generateId(), githubId: 431200, githubUsername: 'retiredtick-admin' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  ctx = { db, userId: admin.id, roles: ['READER'] };
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Role', personaRole: 'test-worker' }, ctx)).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name: 'Base tick', cadenceSeconds: 600 } }, ctx);
});

const cast = async (name: string) => {
  const worker = await M.castWorker({}, { appRef: appId, agentRef: agentId, name }, ctx);
  const ticker = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: worker.id } });
  return { worker, ticker };
};
const retire = (id: string) => M.retireWorker({}, { workerRef: id }, ctx);
const rm = (id: string) => M.deleteWorker({}, { workerRef: id, confirmNoExternalAttribution: true }, ctx);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => e?.extensions?.code ?? String(e));

describe('#4312 retire, then worker rm, with ticker templates', () => {
  it('removes a retired never-used casting whose generated ticker retirement soft-deleted, ticker and name freed', async () => {
    const { worker, ticker } = await cast('Miscast');
    await retire(worker.id);
    // The exemption is exercised: retirement really soft-deleted the ticker and ended the worker's own subscription.
    const after = await db.ticker.findUniqueOrThrow({ where: { id: ticker.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(await db.tickerSubscription.count({ where: { tickerId: ticker.id, workerId: worker.id, endedReason: 'WORKER_RETIRED' } })
      + await db.tickerSubscription.count({ where: { tickerId: ticker.id, workerId: worker.id, endedReason: 'TICKER_DELETED' } })).toBe(1);
    expect(await rm(worker.id)).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.ticker.count({ where: { id: ticker.id } })).toBe(0);
    expect((await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Miscast' }, ctx)).id).not.toBe(worker.id);
  });

  it('control: an edited generated ticker still refuses after retirement', async () => {
    const { worker, ticker } = await cast('Edited');
    await M.updateTicker({}, { ref: ticker.id, input: { cadenceSeconds: 900 } }, ctx);
    await retire(worker.id);
    expect(await refusal(rm(worker.id))).toBe('WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
  });

  it('control: a subscription another worker holds still refuses after retirement', async () => {
    const { worker, ticker } = await cast('Shared');
    const other = await cast('Other');
    await db.tickerSubscription.create({ data: { id: generateId(), tickerId: ticker.id, workerId: other.worker.id } });
    await retire(worker.id);
    expect(await refusal(rm(worker.id))).toBe('WORKER_IN_USE');
  });

  it('control: a delivered tick still refuses after retirement', async () => {
    const { worker, ticker } = await cast('Delivered');
    await db.workerDeliveryTick.create({ data: { workerId: worker.id, tickerId: ticker.id, lastAckedTick: 1, ackedAt: new Date() } });
    await retire(worker.id);
    expect(await refusal(rm(worker.id))).toBe('WORKER_IN_USE');
  });

  it('control: a generated ticker deleted BEFORE the retirement is history and still refuses (#2024)', async () => {
    const { worker, ticker } = await cast('Early');
    await db.ticker.update({ where: { id: ticker.id }, data: { deletedAt: new Date(Date.now() - 60_000) } });
    await retire(worker.id);
    expect(await refusal(rm(worker.id))).toBe('WORKER_IN_USE');
  });

  it('control: a sibling worker with live tickers is unaffected by another worker retiring', async () => {
    const a = await cast('A');
    const b = await cast('B');
    await retire(a.worker.id);
    expect(await rm(a.worker.id)).toBe(true);
    expect(await db.ticker.count({ where: { id: b.ticker.id, deletedAt: null } })).toBe(1);
  });
});
