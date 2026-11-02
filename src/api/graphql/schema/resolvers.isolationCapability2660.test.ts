/** #2660 / cor:agt:080:29: capability and writer share the person-manager-or-holder decision. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { setS7AvailableForTest } from '../../../lib/tickers/s7Availability.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const F = (resolvers as any).WorkerWakeSettings;
let orgId: string, appId: string, agentId: string, targetId: string, otherId: string;
let adminId: string, holderId: string, ownerMemberId: string, memberId: string, outsiderId: string;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const cap = async (c: Context) => {
  const row = await Q.workerWakeSettings({}, { workerRef: targetId }, c);
  expect(F.canManageIsolation, 'capability field resolver exists').toBeTypeOf('function');
  return F.canManageIsolation(row, {}, c);
};
beforeEach(async () => {
  await cleanDb(db);
  setS7AvailableForTest(true);
  orgId = (await db.organization.create({ data: { name: 'Isolation capability', urn: 'cap2660.test' } })).id;
  const user = async (handle: string) => (await db.user.create({ data: { handle } })).id;
  [adminId, holderId, ownerMemberId, memberId, outsiderId] = await Promise.all(
    ['cap-admin', 'cap-holder', 'cap-owner', 'cap-member', 'cap-outsider'].map(user));
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  agentId = (await db.agent.create({ data: { organizationId: orgId, name: 'Capability agent', urn: 'cap2660.test:agent' } })).id;
  appId = (await db.app.create({ data: { organizationId: orgId, name: 'Capability App', urn: 'cap2660.test:app' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  for (const userId of [holderId, ownerMemberId, memberId]) {
    await db.appMember.create({ data: { appId, userId, role: userId === ownerMemberId ? 'owner' : 'member' } });
  }
  const worker = async (name: string, heldByUserId: string) => (await db.worker.create({ data: {
    appId, agentId, name, slug: name.toLowerCase(), signature: '', trailer: '', heldByUserId,
  } })).id;
  targetId = await worker('Target', holderId);
  otherId = await worker('Other', memberId);
});
afterEach(() => { setS7AvailableForTest(false); vi.restoreAllMocks(); });

describe('#2660 capability differential', () => {
  it.each(['admin', 'holder', 'owner member', 'participant', 'different holder', 'own worker', 'manager worker', 'holder other worker', 'impersonation', 'impersonated holder'] as const)(
    '%s equals whether the writer admits this actor', async kind => {
      const ids = { admin: adminId, holder: holderId, 'owner member': ownerMemberId,
        participant: memberId, 'different holder': memberId, 'own worker': holderId,
        'manager worker': adminId, 'holder other worker': holderId, impersonation: adminId, 'impersonated holder': holderId };
      const c = ctx(ids[kind], kind.startsWith('impersonat') ? { impersonation: {
        sessionId: generateId(), actorUserId: outsiderId, orgId, expiresAt: new Date(Date.now() + 3600_000),
      } } as never : {});
      const run = async () => {
        const allowed = await cap(c);
        expect(allowed).toBe(['admin', 'holder', 'owner member'].includes(kind));
        const before = await db.workerWakeSettings.findUnique({ where: { workerId: targetId } });
        let succeeded = false;
        try { await M.isolateWorker({}, { workerRef: targetId }, c); succeeded = true; } catch (e) {
          expect((e as any).extensions.code).toMatch(/^(WORKER_ISOLATION_FORBIDDEN|FORBIDDEN)$/);
        }
        expect(allowed).toBe(succeeded);
        if (!allowed) expect(await db.workerWakeSettings.findUnique({ where: { workerId: targetId } })).toEqual(before);
        if (allowed) await M.clearWorkerIsolation({}, { workerRef: targetId }, c);
        else {
          await expect(M.clearWorkerIsolation({}, { workerRef: targetId }, c)).rejects.toMatchObject({ extensions: { code: expect.stringMatching(/^(WORKER_ISOLATION_FORBIDDEN|FORBIDDEN)$/) } });
          expect(await db.workerWakeSettings.findUnique({ where: { workerId: targetId } })).toEqual(before);
        }
      };
      if (kind.includes('worker')) await runAsActor({ workerId: kind === 'own worker' ? targetId : otherId, agentId }, run);
      else await run();
    });

  it('permission is independent of S7 availability, and reads have no effects', async () => {
    setS7AvailableForTest(false);
    expect(await cap(ctx(adminId))).toBe(true);
    expect(await cap(ctx(holderId))).toBe(true);
    expect(await cap(ctx(memberId))).toBe(false);
    expect(await db.workerWakeSettings.count()).toBe(0);
    await expect(M.isolateWorker({}, { workerRef: targetId }, ctx(adminId))).rejects.toMatchObject({ extensions: { code: 'WORKER_ISOLATION_UNAVAILABLE' } });
    const cleared = await M.clearWorkerIsolation({}, { workerRef: targetId }, ctx(holderId));
    expect(await F.canManageIsolation(cleared, {}, ctx(holderId))).toBe(true);
  });

  it('outsiders and App keys keep the existing concealed read refusal', async () => {
    const row = await Q.workerWakeSettings({}, { workerRef: targetId }, ctx(adminId));
    for (const c of [ctx(outsiderId), ctx(undefined, { appId } as never)]) {
      await expect(cap(c)).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
      await expect(F.canManageIsolation(row, {}, c)).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
    }
    await db.appMember.delete({ where: { appId_userId: { appId, userId: holderId } } });
    await expect(cap(ctx(holderId))).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
    await expect(F.canManageIsolation(row, {}, ctx(holderId))).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
  });

  it('retired workers and invalid session bindings do not advertise write permission', async () => {
    expect(await cap(ctx(adminId, { sessionBindingRefused: true }))).toBe(false);
    await db.worker.update({ where: { id: targetId }, data: { retiredAt: new Date() } });
    expect(await cap(ctx(adminId))).toBe(false);
  });

  it('GraphQL exposes the non-null field on reads and mutation results', async () => {
    const server = new ApolloServer({ typeDefs, resolvers: resolvers as never });
    try {
      const r = await server.executeOperation({ query: 'query($ref:String!){workerWakeSettings(workerRef:$ref){canManageIsolation}}', variables: { ref: targetId } }, { contextValue: ctx(holderId) });
      expect(r.body.kind).toBe('single');
      if (r.body.kind === 'single') {
        expect(r.body.singleResult.errors).toBeUndefined();
        expect(r.body.singleResult.data?.workerWakeSettings).toEqual({ canManageIsolation: true });
      }
      const cleared = await server.executeOperation({ query: 'mutation($ref:String!){clearWorkerIsolation(workerRef:$ref){canManageIsolation}}', variables: { ref: targetId } }, { contextValue: ctx(holderId) });
      expect(cleared.body.kind).toBe('single');
      if (cleared.body.kind === 'single') {
        expect(cleared.body.singleResult.errors).toBeUndefined();
        expect(cleared.body.singleResult.data?.clearWorkerIsolation).toEqual({ canManageIsolation: true });
      }
    } finally { await server.stop(); }
  });

  it('the wake-settings read carries the same capability for person and worker sessions (moved from the MCP wrapper, #3082)', async () => {
    const plain = await db.session.create({ data: { id: generateId(), userId: adminId } });
    const bound = await db.session.create({ data: { id: generateId(), userId: adminId, appId, workerId: otherId, agentId } });
    expect(await cap(ctx(adminId, { sessionId: plain.id }))).toBe(true);
    await runAsActor({ workerId: otherId, agentId }, async () => {
      expect(await cap(ctx(adminId, { sessionId: bound.id }))).toBe(false);
    });
  });

  it('propagates a capability lookup failure instead of silently advertising a denial', async () => {
    const s = await Q.workerWakeSettings({}, { workerRef: targetId }, ctx(adminId));
    const failure = new Error('synthetic manager lookup failure');
    const lookup = db.orgMember.findFirst.bind(db.orgMember);
    const managerLookup = vi.spyOn(db.orgMember, 'findFirst').mockImplementation((args: any) => {
      if (args?.where?.role) throw failure;
      return lookup(args);
    });
    // The same injected fault must leave the parent read guard usable.
    await expect(Q.workerWakeSettings({}, { workerRef: targetId }, ctx(adminId))).resolves.toBeDefined();
    await expect(F.canManageIsolation(s, {}, ctx(adminId))).rejects.toBe(failure);
    expect(managerLookup.mock.calls.some(([args]: any[]) => args?.where?.role)).toBe(true);
  });
});
