/**
 * #3867: the batched `AgentTask.result` recheck (readableTasks, one decision per request) keeps every boundary the per-row
 * gate had. Pins what batching could blur: rows of a readable and an unreadable App in ONE batch, two callers resolving in the
 * SAME tick, and the run-principal arm (own App only, and only while its automation holds a live team snapshot grant).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { testRunAgentId } from '../../../test/runAgent.js';

const F = resolvers as any;
const M = resolvers.Mutation as any;
let orgId: string, appA: string, appB: string, member: string, outsider: string, manager: string;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

async function task(appId: string, title: string) {
  const agent = await db.agent.create({ data: { name: `Ag-${title}`, urn: `batch-${generateId()}:agent`, organizationId: orgId } });
  const w = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: `W${title}`, slug: `w-${title}` } })).id;
  const now = new Date();
  await db.agentTask.create({ data: { appId, title, ownerUserId: manager, assigneeWorkerId: w, assignedAt: now, createdByWorkerId: w,
    status: 'finished', startedAt: now, finishedAt: now,
    resultOutcome: 'succeeded', resultSummary: `sum-${title}`, resultEvidence: 'e', resultFindings: [{ id: 'f', text: 'x' }] as any } });
}
/** The wide row a list page hands out: no findings payload, so `result` must recheck the gate. */
const wideRow = (title: string) => db.agentTask.findFirstOrThrow({ where: { title }, omit: { resultFindings: true } });

async function schedule(appId: string) {
  return (await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, name: 'Auto', cron: '* * * * *',
    entryNodeUrn: 'hrn:node:batch3867.example:flows:report' } })).id;
}
async function mintRun(appId: string, triggerId: string) {
  return db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: await testRunAgentId(db, orgId, appId), userId: null, triggerKind: 'SCHEDULE', triggerId,
    entryNodeUrn: 'hrn:node:batch3867.example:flows:report', status: 'RUNNING' } });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Batch', urn: `batch-${generateId()}.example` } });
  orgId = org.id;
  const user = async () => (await db.user.create({ data: { handle: `b-${generateId()}`, roles: ['READER'] } })).id;
  [member, outsider, manager] = await Promise.all([user(), user(), user()]);
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager, role: 'ADMIN' } });
  appA = (await db.app.create({ data: { name: 'A', urn: `${org.urn}:a`, organizationId: orgId } })).id;
  appB = (await db.app.create({ data: { name: 'B', urn: `${org.urn}:b`, organizationId: orgId } })).id;
  await db.appMember.create({ data: { appId: appA, userId: member, role: 'member' } });
  await task(appA, 'a1'); await task(appA, 'a2'); await task(appB, 'b1');
});

describe('#3867 batched result gate', () => {
  it('one caller, one tick: rows of a readable App answer, rows of an unreadable App read as no result', async () => {
    const [a1, a2, b1] = await Promise.all([wideRow('a1'), wideRow('a2'), wideRow('b1')]);
    const c = ctx(member);
    const [ra1, rb1, ra2] = await Promise.all([F.AgentTask.result(a1, {}, c), F.AgentTask.result(b1, {}, c), F.AgentTask.result(a2, {}, c)]);
    expect(ra1).toMatchObject({ outcome: 'succeeded', summary: 'sum-a1' });
    expect(ra2).toMatchObject({ outcome: 'succeeded', summary: 'sum-a2' });
    expect(rb1).toBeNull();
  });

  it('two callers, same tick: the batch is per request, so an outsider never rides a participant\'s decision', async () => {
    const a1 = await wideRow('a1');
    const [mine, theirs] = await Promise.all([F.AgentTask.result(a1, {}, ctx(member)), F.AgentTask.result(a1, {}, ctx(outsider))]);
    expect(mine).toMatchObject({ outcome: 'succeeded' });
    expect(theirs).toBeNull();
  });

  describe('run principal', () => {
    it('reads its own App\'s result under a live grant; another App\'s row and a refused team read answer null', async () => {
      const trigger = await schedule(appA);
      await M.setAutomationTeamSnapshotGrant(null, { appRef: appA, triggerKind: 'SCHEDULE', triggerId: trigger }, ctx(manager));
      const run = runContext(db, await mintRun(appA, trigger));
      const [a1, b1] = await Promise.all([wideRow('a1'), wideRow('b1')]);
      const [own, foreign] = await Promise.all([F.AgentTask.result(a1, {}, run), F.AgentTask.result(b1, {}, run)]);
      expect(own).toMatchObject({ outcome: 'succeeded', summary: 'sum-a1' });
      expect(foreign).toBeNull();

      const grant = await db.appAutomationTeamSnapshotGrant.findFirstOrThrow({ where: { appId: appA, triggerId: trigger, revokedAt: null } });
      await M.revokeAutomationTeamSnapshotGrant(null, { id: grant.id }, ctx(manager));
      expect(await F.AgentTask.result(a1, {}, runContext(db, await mintRun(appA, trigger)))).toBeNull();
    });

    it('a run whose automation never held a grant reads no result', async () => {
      const trigger = await schedule(appA);
      const run = runContext(db, await mintRun(appA, trigger));
      expect(await F.AgentTask.result(await wideRow('a1'), {}, run)).toBeNull();
    });
  });
});
