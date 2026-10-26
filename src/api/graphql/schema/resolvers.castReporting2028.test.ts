/** S12: explicit reporting choice, legacy omission, and permanent-mint atomicity. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const W = resolvers.Worker as any;
let app: { id: string }; let agent: { id: string }; let user: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
const args = (choice: Record<string, unknown> = {}) => ({ appRef: app.id, agentRef: agent.id, name: 'Newcomer', ...choice });
beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { githubId: 2028001, githubUsername: 's12-owner' } });
  const org = await db.organization.create({ data: { name: 'S12', urn: `s12-${generateId()}.com` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'S12 agent' }, ctx());
  app = await db.app.create({ data: { organizationId: org.id, name: 'S12 app', urn: `s12-${generateId()}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});
afterEach(() => vi.unstubAllEnvs());

describe('S12 cast choice', () => {
  it('records explicit no-team and returns the same placement in preview', async () => {
    const preview = await Q.castWorkerPreview({}, args({ noTeam: true }), ctx());
    expect(preview.teamPlacement).toBe('NO_TEAM');
    expect(await db.worker.count()).toBe(0);
    const worker = await M.castWorker({}, args({ noTeam: true }), ctx());
    const row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((row as any).explicitNoTeam).toBe(true);
    expect(row.reportsToWorkerId).toBeNull();
    expect(await W.teamPlacement(row, {}, ctx())).toBe('NO_TEAM');
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: row.id, type: 'worker.reports-to' } })).toBe(1);
  });
  it('keeps true legacy omission UNSET while default OFF, with no choice event', async () => {
    const worker = await M.castWorker({}, args(), ctx());
    const row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await W.teamPlacement(row, {}, ctx())).toBe('UNSET');
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: row.id } })).toBe(0);
  });
  for (const required of [false, true]) {
    for (const choice of [{ noTeam: null }, { noTeam: false }, { reportsTo: null }, { reportsTo: ' ' }]) {
      it(`refuses explicit invalid ${JSON.stringify(choice)} with enforcement ${required}`, async () => {
        vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
        for (const operation of [M.castWorker, Q.castWorkerPreview]) {
          await expect(operation({}, args(choice), ctx())).rejects.toMatchObject({
            message: 'reportsTo must be a non-empty worker reference, or noTeam must be true.',
            extensions: { code: 'WORKER_TEAM_CHOICE_INVALID' },
          });
        }
        expect(await db.worker.count()).toBe(0);
      });
    }
    it(`both supplied dominates invalid values with enforcement ${required}`, async () => {
      vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
      for (const operation of [M.castWorker, Q.castWorkerPreview]) {
        await expect(operation({}, args({ reportsTo: null, noTeam: null }), ctx())).rejects.toMatchObject({
          message: 'Supply reportsTo or noTeam, never both.', extensions: { code: 'WORKER_TEAM_CHOICE_CONFLICT' },
        });
      }
      expect(await db.worker.count()).toBe(0);
    });
  }
  it('requires choice only when enforcement is ON', async () => {
    vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', 'true');
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, args(), ctx())).rejects.toMatchObject({
        message: 'Choose reportsTo or noTeam: true when casting a worker.', extensions: { code: 'WORKER_TEAM_CHOICE_REQUIRED' },
      });
    }
    expect(await db.worker.count()).toBe(0);
  });
});
