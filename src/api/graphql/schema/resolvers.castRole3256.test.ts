/** #3256 / cor:dmo:050:11: cast and change both require the Agent's own nonblank role. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let admin: { id: string }, org: { id: string }, app: { id: string }, agent: { id: string };
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
const cast = (context = ctx()) => M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'RolePin' }, context);

// Every table below lives in the test worker's private DB; no real team worker/session is touched.
const snapshot = async () => ({
  workers: await db.worker.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
  tickers: await db.ticker.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
  memories: await db.memory.findMany({ orderBy: { id: 'asc' } }),
  grants: await db.agentOrgGrant.findMany({ where: { orgId: org.id }, orderBy: { agentId: 'asc' } }),
  appGrants: await db.appGrant.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
  writeGrants: await db.appMemoryWriteGrant.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
  writeGrantEvents: await db.appMemoryWriteGrantEvent.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
});

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Role pin', urn: `role-${generateId().toLowerCase()}.example` } });
  admin = await db.user.create({ data: { handle: `role-${generateId()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Role pin', urn: `role-${generateId().toLowerCase()}.example:team` } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Role pin', personaRole: 'security-engineer' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'ROLE {{worker.role}}');
  await M.createAgentTickerTemplate({}, { agentRef: agent.id, input: { name: 'role tick', cadenceSeconds: 600 } }, ctx());
});

describe('#3256 roleless cast', () => {
  it.each([null, '', '   ', '\t\n'])('refuses role %j with WORKER_AGENT_HAS_NO_ROLE and writes nothing', async personaRole => {
    await db.agent.update({ where: { id: agent.id }, data: { personaRole } });
    const before = await snapshot();
    await expect(cast()).rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_HAS_NO_ROLE' } });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['security-engineer', ' \tsecurity-engineer \n'])('casts valid role %j, trimmed like change, and instantiates its ticker', async personaRole => {
    await db.agent.update({ where: { id: agent.id }, data: { personaRole } });
    const worker = await cast();
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({ agentId: agent.id, role: 'security-engineer' });
    expect(await db.ticker.count({ where: { generatedForWorkerId: worker.id, deletedAt: null } })).toBe(1);
  });

  it('preview uses the same role refusal without reserving or writing anything', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { personaRole: null } });
    const before = await snapshot();
    await expect((resolvers.Query as any).castWorkerPreview({}, {
      appRef: app.id, agentRef: agent.id, name: 'RolePin',
    }, ctx())).rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_HAS_NO_ROLE' } });
    expect(await snapshot()).toEqual(before);
  });

  for (const personaRole of [null, '', '   ']) {
    it(`rechecks role ${JSON.stringify(personaRole)} committed after planning and before the cast transaction`, async () => {
      let injected = 0;
      let afterChange: Awaited<ReturnType<typeof snapshot>> | undefined;
      const client = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== '$transaction') return Reflect.get(target, key, receiver);
          return async (fn: any, options: any) => {
            injected++;
            // This is a separately committed writer in the real preflight/transaction gap, not an ACL mock.
            await db.agent.update({ where: { id: agent.id }, data: { personaRole } });
            afterChange = await snapshot();
            return target.$transaction(fn, options);
          };
        },
      });
      await expect(cast({ ...ctx(), db: client })).rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_HAS_NO_ROLE' } });
      expect(injected).toBe(1);
      expect(afterChange).toBeDefined();
      expect(await snapshot()).toEqual(afterChange);
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).personaRole).toBe(personaRole);
    });
  }

  it('preserves installation, role-override and licence refusals before the missing-role answer', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { personaRole: null } });
    const before = await snapshot();
    const args = { appRef: app.id, agentRef: agent.id, name: 'RolePin' };
    await expect(M.castWorker({}, { ...args, role: 'override' }, ctx())).rejects.toMatchObject({ extensions: { code: 'WORKER_ROLE_OVERRIDE_REFUSED' } });
    expect(await snapshot()).toEqual(before);
    await db.agentOrgGrant.upsert({
      where: { orgId_agentId: { orgId: org.id, agentId: agent.id } },
      create: { orgId: org.id, agentId: agent.id, revokedAt: new Date() }, update: { revokedAt: new Date() },
    });
    const revoked = await snapshot();
    await expect(cast()).rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
    expect(await snapshot()).toEqual(revoked);
    await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: agent.id } } });
    const uninstalled = await snapshot();
    await expect(cast()).rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_NOT_INSTALLED' } });
    expect(await snapshot()).toEqual(uninstalled);
  });

  it.each([null, '', '   '])('change keeps the same role %j refusal, workerId and no-write behavior', async personaRole => {
    const worker = await cast();
    const target = await M.createAgent({}, { orgId: org.id, name: 'Change target', personaRole: 'target-role' }, ctx());
    await db.appAgent.create({ data: { appId: app.id, agentId: target.id } });
    await serveAgentBootPrompt(db, target.id, 'TARGET {{worker.role}}');
    await db.agent.update({ where: { id: target.id }, data: { personaRole } });
    const before = await snapshot();
    await expect(M.changeWorkerAgent({}, { workerRef: worker.id, agentRef: target.id }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_HAS_NO_ROLE', workerId: worker.id } });
    expect(await snapshot()).toEqual(before);
  });
});
