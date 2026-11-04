import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { GRANT_SUBSCRIBE_WORKERS } from '../../../lib/tickers/bounds.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAutomationReadGrantTools } from '../../../mcp/automationReadGrantTools.js';
import { registerAutomationTeamSnapshotGrantTools } from '../../../mcp/automationTeamSnapshotGrantTools.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start()); afterAll(() => server.stop());
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const A = resolvers.App as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-17' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const answer = async (p: Promise<unknown>) => { try { await p; return { code: 'RESOLVED' }; } catch (e: any) { return { code: e.extensions?.code, message: e.message }; } };
const instructionEvents = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } })
  .then((es) => es.filter((e) => (e.payload as any)?.instruction));
const snapshot = async () => ({
  readGrants: await db.appAutomationReadGrant.findMany({ orderBy: { id: 'asc' } }),
  teamGrants: await db.appAutomationTeamSnapshotGrant.findMany({ orderBy: { id: 'asc' } }),
  readEvents: await db.appAutomationReadGrantEvent.findMany({ orderBy: { id: 'asc' } }),
  teamEvents: await db.appAutomationTeamSnapshotGrantEvent.findMany({ orderBy: { id: 'asc' } }),
  scopes: await db.appKeyScope.findMany({ orderBy: { id: 'asc' } }),
  grants: await db.appGrant.findMany({ orderBy: { id: 'asc' } }),
  writeGrants: await db.appMemoryWriteGrant.findMany({ orderBy: { id: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
});

const revokes: Record<string, (instruction?: unknown, c?: Context) => Promise<any>> = {
  read: (instruction = live, c = bound()) => M.revokeAutomationReadGrant({}, { id: f.readGrant.id, instruction }, c),
  team: (instruction = live, c = bound()) => M.revokeAutomationTeamSnapshotGrant({}, { id: f.teamGrant.id, instruction }, c),
};
const lists: Record<string, (instruction?: unknown, c?: Context) => Promise<any>> = {
  readList: (instruction = live, c = bound()) => Q.automationReadGrants({}, { appRef: f.app.id, instruction }, c),
  teamList: (instruction = live, c = bound()) => Q.automationTeamSnapshotGrants({}, { appRef: f.app.id, instruction }, c),
};
const doors = { ...revokes, ...lists };

/** Real committed writes at named transaction boundaries; no authorization result is mocked. */
function atGrantBoundary(beforeTransaction?: () => Promise<void>, beforeSessionLock?: () => Promise<void>): Context['db'] {
  return new Proxy(db, { get(client, key) {
    if (key !== '$transaction') return Reflect.get(client, key);
    return async (body: any, options: any) => {
      await beforeTransaction?.();
      return db.$transaction(async tx => body(new Proxy(tx, { get(transaction, method) {
        if (method !== '$queryRaw') return Reflect.get(transaction, method);
        return async (...args: any[]) => {
          const sql = Array.isArray(args[0]) ? args[0].join('?') : '';
          if (sql.includes('FROM sessions') && sql.includes('FOR SHARE')) await beforeSessionLock?.();
          return (transaction.$queryRaw as any)(...args);
        };
      } })), options);
    };
  } }) as Context['db'];
}
const isList = (door: string) => door in lists;
beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'cred-holder', roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: 'cred-other', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Cred', urn: 'cred3311.test' } });
  await db.orgMember.createMany({
    data: [
      { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
      { organizationId: org.id, userId: other.id, role: 'ADMIN' },
    ]
  });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'cred3311.test:team' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'cred3311.test:agent', name: 'Agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Target', slug: 'target' } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'abcd', label: 'K' } });
  await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: holder.id } });
  await db.appGrant.create({ data: { appId: app.id, granteeWorkerId: target.id, name: GRANT_SUBSCRIBE_WORKERS, grantedBy: holder.id } });
  const mem = await db.memory.create({ data: { name: 'dest', urn: 'cred3311.test:dest', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
  const writeGrant = await db.appMemoryWriteGrant.create({ data: { appId: app.id, memoryId: mem.id, prefix: 'reports:x', grantedBy: holder.id } });
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'grant', cron: '* * * * *', entryNodeUrn: 'hrn:node:cred3311.test:flows:main' } });
  const readGrant = await db.appAutomationReadGrant.create({ data: { appId: app.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, memoryId: mem.id, grantedBy: holder.id } });
  const teamGrant = await db.appAutomationTeamSnapshotGrant.create({ data: { appId: app.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, grantedBy: holder.id } });
  f = { holder, other, org, app, agent, worker, target, session, key, mem, writeGrant, schedule, readGrant, teamGrant };
});

describe('#3361 instructed automation grants', () => {
  for (const [door, call] of Object.entries(doors)) {
    it(`${door}: an owner-role holder's instruction is admitted${isList(door) ? ' and writes one record per call' : ' with exactly one attributed record'}`, async () => {
      await call();
      const es = await instructionEvents();
      expect(es).toHaveLength(1);
      expect(es[0]).toMatchObject({ actorUserId: f.holder.id, actorWorkerId: f.worker.id });
      expect((es[0].payload as any).instruction).toEqual(live);
      if (isList(door)) { await call(); expect(await instructionEvents()).toHaveLength(2); }
    });
    it(`${door}: an org ADMIN holder's instruction is admitted`, async () => {
      await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
      await call();
      expect(await instructionEvents()).toHaveLength(1);
    });
    it(`${door}: a direct person writes no instruction record`, async () => {
      await call(null, ctx());
      expect(await instructionEvents()).toHaveLength(0);
    });
    it(`${door}: the record names the act and carries no key, scope or grant id`, async () => {
      await call();
      const [e] = await instructionEvents();
      const text = JSON.stringify(e.payload) + JSON.stringify(e);
      for (const id of [f.key.id, f.writeGrant.id, f.readGrant.id, f.teamGrant.id, f.mem.id, f.target.id]) expect(text).not.toContain(id);
      expect(text).not.toContain('attention:deliver');
    });
    for (const kind of ['no-instruction', 'host-launch', 'unheld', 'other-holder', 'ended-session', 'retired-worker', 'plain-member', 'impersonation', 'app-key', 'refused-binding', 'ambiguous', 'run'] as const) {
      it(`${door}: ${kind} is refused and writes nothing`, async () => {
        let c = bound(); let claim: unknown = live;
        if (kind === 'no-instruction') claim = null;
        if (kind === 'host-launch') await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
        if (kind === 'unheld' || kind === 'other-holder') await db.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: kind === 'unheld' ? null : f.other.id } });
        if (kind === 'ended-session') await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
        if (kind === 'retired-worker') await db.worker.update({ where: { id: f.worker.id }, data: { retiredAt: new Date() } });
        if (kind === 'plain-member') await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
        if (kind === 'impersonation') c = bound({ impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } } as any);
        if (kind === 'app-key') c = { db, appId: f.app.id, roles: [] } as Context;
        if (kind === 'refused-binding') c = bound({ sessionBindingRefused: true });
        if (kind === 'run') c = bound({ clientId: 'run:test', appId: f.app.id });
        const before = await snapshot();
        const invoke = () => call(claim, c);
        const got = await answer(kind === 'ambiguous' ? requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['a', 'b'] }, invoke) : invoke());
        expect(got.code).toBe('FORBIDDEN');
        // A typed refusal, never a crash.
        expect(await snapshot()).toEqual(before);
      });
    }
    it(`${door}: a holder who does not manage the App gets that holder's own refusal, byte-identical`, async () => {
      await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
      const before = await snapshot();
      const worker = await answer(call(live, bound()));
      const person = await answer(call(null, ctx()));
      if (door !== 'readList') expect(worker).toEqual(person);
      else expect(person.code).toBe('RESOLVED'); // legacy person list filters to empty, worker has no admitted holder right
      expect(worker.code).not.toBe('RESOLVED');
      expect(await snapshot()).toEqual(before);
    });
  }


  for (const [name, call] of Object.entries(revokes)) it(`${name} repeated revoke is terminal and records once`, async () => {
    await call(); const before = await snapshot(); await call(); expect(await snapshot()).toEqual(before);
  });
  for (const [name, call] of Object.entries(lists)) it(`${name} empty admitted list records once`, async () => {
    await db.appAutomationReadGrant.updateMany({ data: { revokedAt: new Date(), revokedBy: f.holder.id } });
    await db.appAutomationTeamSnapshotGrant.updateMany({ data: { revokedAt: new Date(), revokedBy: f.holder.id } });
    const out = await call(); expect(Array.isArray(out) ? out : out.items).toEqual([]); expect(await instructionEvents()).toHaveLength(1);
  });
  it('memory-only instructed list is bound to worker App; direct target manager keeps other-App reach', async () => {
    await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
    const app = await db.app.create({ data: { organizationId: f.org.id, name: 'Other', urn: 'cred3311.test:other' } });
    const grant = await db.appAutomationReadGrant.create({ data: { appId: app.id, triggerKind: 'SCHEDULE', triggerId: generateId(), memoryId: f.mem.id, grantedBy: f.holder.id } });
    const out = await Q.automationReadGrants({}, { memoryRef: f.mem.id, instruction: live }, bound());
    expect(out.map((r: any) => r.id)).toEqual([f.readGrant.id]);
    expect((await Q.automationReadGrants({}, { memoryRef: f.mem.id }, ctx())).map((r: any) => r.id)).toContain(grant.id);
    const before = await snapshot();
    expect((await answer(Q.automationReadGrants({}, { appRef: app.id, instruction: live }, bound()))).code).toBe('FORBIDDEN');
    expect((await answer(M.revokeAutomationReadGrant({}, { id: grant.id, instruction: live }, bound()))).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
    await M.revokeAutomationReadGrant({}, { id: grant.id }, ctx());
    expect((await db.appAutomationReadGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedBy).toBe(f.holder.id);
  });

  const surfaces = [
    ['read', 'revokeAutomationReadGrant', 'hadron_revoke_automation_read_grant', true],
    ['team', 'revokeAutomationTeamSnapshotGrant', 'hadron_revoke_automation_team_snapshot_grant', true],
    ['readList', 'automationReadGrants', 'hadron_list_automation_read_grants', false],
    ['teamList', 'automationTeamSnapshotGrants', 'hadron_list_automation_team_snapshot_grants', false],
  ] as const;
  for (const [name, field, tool, revoke] of surfaces) for (const surface of ['graphql', 'mcp']) it(`${surface} ${name} shares instruction admission and zero-effects refusal`, async () => {
    const id = name === 'read' ? f.readGrant.id : f.teamGrant.id;
    async function invoke(instruction: unknown) {
      if (surface === 'graphql') {
        const selector = revoke ? 'id' : 'appRef'; const scalar = revoke || name === 'teamList' ? 'ID!' : 'String';
        const selection = name === 'teamList' ? 'items{id} total' : 'id';
        const query = `${revoke ? 'mutation' : 'query'}($ref:${scalar},$instruction:ActInstructionInput){${field}(${selector}:$ref,instruction:$instruction){${selection}}}`;
        const r = await server.executeOperation({ query, variables: { ref: revoke ? id : f.app.id, instruction } }, { contextValue: bound() });
        if (r.body.kind !== 'single') throw Error('incremental');
        return r.body.singleResult;
      }
      const mcp = createMcpServerInstance({ userId: f.holder.id, roles: ['READER'], appId: f.app.id, sessionId: f.session.id, clientId: 'github:test' } as any, () => undefined, { kind: 'multi-app' });
      const client = new Client({ name: '3361', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(b); await client.connect(a);
      try { return await client.callTool({ name: tool, arguments: { ...(revoke ? { id } : { app: f.app.id }), instruction } }); }
      finally { await client.close(); await mcp.close(); }
    }
    const before = await snapshot();
    const refused = await invoke(null);
    expect(JSON.stringify(refused)).toMatch(/FORBIDDEN|forbidden/); expect(await snapshot()).toEqual(before);
    const success: any = await invoke(live); expect(success.errors).toBeUndefined(); expect(success.isError).not.toBe(true);
    expect(await instructionEvents()).toHaveLength(1);
  });
  for (const [name, call] of Object.entries(doors)) for (const claim of [
    { kind: 'LIVE_CHAT', ref: 'pasted prose' }, { kind: 'TASK', ref: 'hrn:agenttask:cred3311.test:team:AT999' },
    { kind: 'TEAM_CHAT_MESSAGE', ref: 'hrn:node:cred3311.test:unknown:missing' },
  ]) it(`${name} invalid or unreadable ${claim.kind} refuses without effects`, async () => {
    const before = await snapshot(); expect((await answer(call(claim))).code).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
  });
  for (const [name, call] of Object.entries(doors)) it(`${name} fences session end and hold release through the event`, async () => {
    let sessionBlocked = false, holdBlocked = false;
    const c = bound({ db: db.$extends({ query: { agentTeamEvent: { create: async ({ args, query }: any) => {
      for (const which of ['session', 'worker']) {
        try {
          await db.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
            if (which === 'session') await tx.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
            else await tx.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: null } });
          });
        } catch (e: any) {
          if (!/lock timeout/.test(e.message)) throw e;
          if (which === 'session') sessionBlocked = true;
          else holdBlocked = true;
        }
      }
      return query(args);
    } } } }) as any });
    await call(live, c); expect(sessionBlocked).toBe(true); expect(holdBlocked).toBe(true);
  });
  for (const [name, call] of Object.entries(doors)) for (const kind of ['TASK', 'TEAM_CHAT_MESSAGE']) it(`${name} admits a readable same-App ${kind}`, async () => {
    let ref: string;
    if (kind === 'TASK') { const task = await db.agentTask.create({ data: { appId: f.app.id, title: 'instruction', ownerUserId: f.holder.id } }); ref = `hrn:agenttask:${f.app.urn}:${task.handle}`; }
    else ref = (await M.createTeamChatMessage({}, { appRef: f.app.id, body: 'fixture instruction' }, ctx())).urn;
    await call({ kind, ref }); expect(await instructionEvents()).toHaveLength(1);
  });
  it('a target-only manager keeps memory revoke/list; has no snapshot authority', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    await db.memory.update({ where: { id: f.mem.id }, data: { organizationId: null, ownerUserId: f.holder.id } });
    expect((await lists.readList!()).map((r: any) => r.id)).toEqual([f.readGrant.id]);
    await revokes.read!();
    const before = await snapshot();
    for (const call of [lists.teamList!, revokes.team!]) expect((await answer(call())).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });
  for (const name of ['read', 'team']) it(`${name} grant revoke rolls back if instruction event fails`, async () => {
    const before = await snapshot();
    const c = bound({ db: db.$extends({ query: { agentTeamEvent: { create: async () => { throw Error('injected event fault'); } } } }) as any });
    await expect(revokes[name]!(live, c)).rejects.toThrow('injected event fault'); expect(await snapshot()).toEqual(before);
  });

  it('a direct person retains filtered list but anchored revoke refuses an uninstalled App', async () => {
    await db.app.update({ where: { id: f.app.id }, data: { uninstalledAt: new Date() } });
    expect((await lists.readList!(null, ctx())).map((r: any) => r.id)).toEqual([f.readGrant.id]);
    const before = await snapshot();
    expect((await answer(revokes.read!(null, ctx()))).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
    expect(await instructionEvents()).toHaveLength(0);
  });

  it('a direct-person memory-only list explicitly refuses a supplied claim, while no claim keeps its reach', async () => {
    const before = await snapshot();
    expect((await answer(Q.automationReadGrants({}, { memoryRef: f.mem.id, instruction: live }, ctx()))).code).toBe('FORBIDDEN');
    expect((await Q.automationReadGrants({}, { memoryRef: f.mem.id }, ctx())).map((r: any) => r.id)).toEqual([f.readGrant.id]);
    expect(await snapshot()).toEqual(before);
  });
  it('a direct-person claim with an explicit App is validated without an instruction event', async () => {
    const task = await db.agentTask.create({ data: { appId: f.app.id, title: 'instruction', ownerUserId: f.holder.id } });
    const instruction = { kind: 'TASK', ref: `hrn:agenttask:${f.app.urn}:${task.handle}` };
    expect((await Q.automationReadGrants({}, { appRef: f.app.id, memoryRef: f.mem.id, instruction }, ctx())).map((r: any) => r.id)).toEqual([f.readGrant.id]);
    expect(await instructionEvents()).toHaveLength(0);
    const before = await snapshot();
    expect((await answer(Q.automationReadGrants({}, { appRef: f.app.id, instruction: { kind: 'TASK', ref: 'hrn:agenttask:cred3311.test:team:AT999' } }, ctx()))).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });

  for (const [, , tool, revoke] of surfaces) for (const principal of ['app-key', 'refused-binding']) it(`MCP ${tool} forwards ${principal} without granting or recording`, async () => {
    const auth = {
      userId: f.holder.id, roles: ['READER'], appId: f.app.id, sessionId: f.session.id,
      ...(principal === 'app-key' ? { appKeyId: f.key.id } : { sessionBindingRefused: true }),
    };
    const mcp = new McpServer({ name: '3361-projection', version: '1' });
    registerAutomationReadGrantTools(mcp, { db, auth: auth as any }); registerAutomationTeamSnapshotGrantTools(mcp, { db, auth: auth as any });
    const client = new Client({ name: '3361-projection', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b); await client.connect(a); const before = await snapshot();
    try {
      const id = tool.includes('team_snapshot') ? f.teamGrant.id : f.readGrant.id;
      const r = await client.callTool({ name: tool, arguments: { ...(revoke ? { id } : { app: f.app.id }), instruction: live } });
      expect(r.isError).toBe(true); expect(JSON.stringify(r)).toContain('[forbidden]'); expect(await snapshot()).toEqual(before);
    } finally { await client.close(); await mcp.close(); }
  });
  for (const [name, call] of Object.entries(doors)) it(`${name} rechecks a hold release committed during the authority wait`, async () => {
    let ready!: () => void, unlock!: () => void; const held = new Promise<void>(r => ready = r), release = new Promise<void>(r => unlock = r);
    const blocker = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: f.app.id }], 'exclusive');
      await tx.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: null } });
      ready(); await release;
    }, { timeout: 20000 });
    await held; const before = await snapshot(); const pending = answer(call());
    try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { unlock(); await blocker; }
    expect((await pending).code).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
  });
  it('a deleted memory target refuses an instructed revoke without an event', async () => {
    await db.memory.update({ where: { id: f.mem.id }, data: { deletedAt: new Date() } }); const before = await snapshot();
    expect((await answer(revokes.read!())).code).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
  });

  for (const [name, call] of Object.entries(doors)) for (const via of ['app-owner', 'org-admin']) it(`${name} fences deciding ${via} membership through recording`, async () => {
    if (via === 'org-admin') {
      await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
    }
    let blocked = false;
    const c = bound({ db: db.$extends({ query: { agentTeamEvent: { create: async ({ args, query }: any) => {
      try {
        await db.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
          if (via === 'app-owner') await tx.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
          else await tx.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'CONTRIBUTOR' } });
        });
      } catch (e: any) { if (/lock timeout/.test(e.message)) blocked = true; else throw e; }
      return query(args);
    } } } }) as any });
    await call(live, c);
    expect(blocked).toBe(true);
  });
  for (const name of ['read', 'readList']) it(`${name} fences a target-only manager membership through recording`, async () => {
    const otherOrg = await db.organization.create({ data: { name: 'Other', urn: 'cred3361.other' } });
    await db.app.update({ where: { id: f.app.id }, data: { organizationId: otherOrg.id } });
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
    await db.memory.update({ where: { id: f.mem.id }, data: { visibility: 'PUBLIC' } });
    let blocked = false;
    const c = bound({ db: db.$extends({ query: { agentTeamEvent: { create: async ({ args, query }: any) => {
      try { await db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await tx.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'CONTRIBUTOR' } });
      }); } catch (e: any) { if (/lock timeout/.test(e.message)) blocked = true; else throw e; }
      return query(args);
    } } } }) as any });
    await doors[name]!(live, c); expect(blocked).toBe(true);
  });

  for (const surface of ['graphql', 'mcp']) it(`${surface} direct-person memory-only claim combination is explicit and has no effects`, async () => {
    const before = await snapshot();
    if (surface === 'graphql') {
      const query = 'query($memory:String!,$instruction:ActInstructionInput){automationReadGrants(memoryRef:$memory,instruction:$instruction){id}}';
      const rejected = await server.executeOperation({ query, variables: { memory: f.mem.id, instruction: live } }, { contextValue: ctx() });
      if (rejected.body.kind !== 'single') throw Error('incremental');
      expect(rejected.body.singleResult.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      const control = await server.executeOperation({ query, variables: { memory: f.mem.id } }, { contextValue: ctx() });
      if (control.body.kind !== 'single') throw Error('incremental');
      expect(control.body.singleResult.errors).toBeUndefined();
      expect((control.body.singleResult.data as any).automationReadGrants).toEqual([{ id: f.readGrant.id }]);
    } else {
      const mcp = new McpServer({ name: '3361-person', version: '1' });
      registerAutomationReadGrantTools(mcp, { db, auth: { userId: f.holder.id, roles: ['READER'], appId: f.app.id } as any });
      const client = new Client({ name: '3361-person', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(b); await client.connect(a);
      try {
        const rejected = await client.callTool({ name: 'hadron_list_automation_read_grants', arguments: { memory: f.mem.id, instruction: live } });
        expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).toContain('[forbidden]');
        const control = await client.callTool({ name: 'hadron_list_automation_read_grants', arguments: { memory: f.mem.id } });
        expect(control.isError).not.toBe(true); expect(JSON.stringify(control)).toContain(f.readGrant.id);
      } finally { await client.close(); await mcp.close(); }
    }
    expect(await snapshot()).toEqual(before);
  });

  for (const [name, call] of Object.entries(doors)) for (const principal of ['key', 'run', 'impersonation', 'binding']) it(`${name} refuses ${principal} before entity lookup`, async () => {
    const noLookup = db.$extends({ query: { $allModels: { $allOperations: async () => { throw Error('unexpected entity lookup'); } } } });
    const extra = principal === 'key' ? { appKeyId: f.key.id } : principal === 'run' ? { clientId: 'run:test' } : principal === 'binding' ? { sessionBindingRefused: true } : {
      impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') },
    };
    expect((await answer(call(live, bound({ ...extra, db: noLookup as any })))).code).toBe('FORBIDDEN');
  });

  it('instructed memory-only unknown and foreign-existing refs are indistinguishable for an App manager', async () => {
    const org = await db.organization.create({ data: { name: 'Foreign', urn: 'cred3361.foreign' } });
    const foreign = await db.memory.create({ data: { name: 'Foreign', urn: 'cred3361.foreign:memory', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as any });
    const refs = [`hrn:mem:${foreign.urn}`, 'hrn:mem:cred3361.foreign:absent'];
    const answers = [];
    for (const memoryRef of refs) {
      answers.push(await Q.automationReadGrants({}, { memoryRef, instruction: live }, bound()));
    }
    expect(answers).toEqual([[], []]);
    const events = await instructionEvents(); expect(events).toHaveLength(2);
    expect(events[0].payload).toEqual(events[1].payload);
    expect(events.every(e => e.appId === f.app.id)).toBe(true);
  });
  it('person LIVE_CHAT claims do not turn an unknown App into an existence oracle', async () => {
    const org = await db.organization.create({ data: { name: 'Foreign', urn: 'cred3361.foreign' } });
    const foreign = await db.app.create({ data: { name: 'Foreign', urn: 'cred3361.foreign:app', organizationId: org.id } });
    const refs = [`hrn:app:${foreign.urn}`, 'hrn:app:cred3361.foreign:absent'];
    for (const instruction of [null, live]) {
      const answers = [];
      for (const appRef of refs) answers.push(await Q.automationReadGrants({}, { appRef, instruction }, ctx()));
      expect(answers).toEqual([[], []]);
    }
    expect(await instructionEvents()).toHaveLength(0);
  });
  it('invalid person claims and non-manager worker memory refs refuse uniformly without events', async () => {
    const org = await db.organization.create({ data: { name: 'Foreign', urn: 'cred3361.foreign' } });
    const foreign = await db.app.create({ data: { name: 'Foreign', urn: 'cred3361.foreign:app', organizationId: org.id } });
    const memory = await db.memory.create({ data: { name: 'Foreign', urn: 'cred3361.foreign:memory', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as any });
    const task = await db.agentTask.create({ data: { appId: f.app.id, title: 'instruction', ownerUserId: f.holder.id } });
    for (const instruction of [{ kind: 'LIVE_CHAT', ref: 'invalid prose' }, { kind: 'TASK', ref: `hrn:agenttask:${f.app.urn}:${task.handle}` }]) {
      const answers = [];
      for (const appRef of [`hrn:app:${foreign.urn}`, 'hrn:app:cred3361.foreign:absent']) answers.push(await answer(Q.automationReadGrants({}, { appRef, instruction }, ctx())));
      expect(answers[0]).toEqual(answers[1]); expect(answers[0].code).toBe('FORBIDDEN');
    }
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    const before = await snapshot(); const answers = [];
    for (const memoryRef of [`hrn:mem:${memory.urn}`, 'hrn:mem:cred3361.foreign:absent']) answers.push(await answer(Q.automationReadGrants({}, { memoryRef, instruction: live }, bound())));
    expect(answers[0]).toEqual(answers[1]); expect(answers[0].code).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
  });

  for (const surface of ['graphql', 'mcp']) it(`${surface} conceals unknown and foreign-existing memory/App references`, async () => {
    const org = await db.organization.create({ data: { name: 'Foreign', urn: 'cred3361.foreign' } });
    const app = await db.app.create({ data: { name: 'Foreign', urn: 'cred3361.foreign:app', organizationId: org.id } });
    const memory = await db.memory.create({ data: { name: 'Foreign', urn: 'cred3361.foreign:memory', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as any });
    for (const worker of [true, false]) {
      const refs = worker ? [`hrn:mem:${memory.urn}`, 'hrn:mem:cred3361.foreign:absent'] : [`hrn:app:${app.urn}`, 'hrn:app:cred3361.foreign:absent'];
      const answers = [];
      for (const ref of refs) {
        if (surface === 'graphql') {
          const selector = worker ? 'memoryRef' : 'appRef';
          const r = await server.executeOperation({ query: `query($ref:String!,$claim:ActInstructionInput){automationReadGrants(${selector}:$ref,instruction:$claim){id}}`, variables: { ref, claim: live } }, { contextValue: worker ? bound() : ctx() });
          if (r.body.kind !== 'single') throw Error('incremental');
          expect(r.body.singleResult.errors).toBeUndefined(); answers.push(r.body.singleResult.data);
        } else {
          const mcp = new McpServer({ name: '3361-oracle', version: '1' });
          registerAutomationReadGrantTools(mcp, { db, auth: { userId: f.holder.id, roles: ['READER'], appId: f.app.id, ...(worker ? { sessionId: f.session.id } : {}) } as any });
          const client = new Client({ name: '3361-oracle', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
          await mcp.connect(b); await client.connect(a);
          try {
            const r = await client.callTool({ name: 'hadron_list_automation_read_grants', arguments: { ...(worker ? { memory: ref } : { app: ref }), instruction: live } });
            expect(r.isError).not.toBe(true); answers.push(r.content);
          } finally { await client.close(); await mcp.close(); }
        }
      }
      expect(answers[0]).toEqual(answers[1]);
      const events = await instructionEvents(); expect(events).toHaveLength(2);
      expect(events[0].payload).toEqual(events[1].payload);
    }
  });

});

describe('#3385 admission interleaves', () => {
  it('target-only manager gets identical unknown/foreign refusals without losing the named-target control', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    await db.memory.update({ where: { id: f.mem.id }, data: { organizationId: null, ownerUserId: f.holder.id } });
    const foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: 'pins3385.foreign' } });
    const foreign = await db.memory.create({ data: { name: 'Foreign', urn: 'pins3385.foreign:memory', class: 'knowledge', organizationId: foreignOrg.id } });
    const before = await snapshot();
    const answers = [];
    for (const memoryRef of [`hrn:mem:${foreign.urn}`, 'hrn:mem:pins3385.foreign:unknown']) {
      answers.push(await answer(Q.automationReadGrants({}, { memoryRef, instruction: live }, bound())));
      expect(await snapshot()).toEqual(before);
    }
    expect(answers[0].code).toBe('FORBIDDEN'); expect(answers[1]).toEqual(answers[0]);
    expect((await Q.automationReadGrants({}, { memoryRef: f.mem.id, instruction: live }, bound())).map((r: any) => r.id)).toEqual([f.readGrant.id]);
    expect(await instructionEvents()).toHaveLength(1);
  });

  for (const [name, call] of Object.entries(doors)) {
    if (!isList(name)) it(`${name}: a session gaining a worker between admissions refuses without effects`, async () => {
      await db.session.update({ where: { id: f.session.id }, data: { workerId: null } });
      let changed = 0;
      const c = bound({ db: atGrantBoundary(async () => {
        changed++;
        await db.session.update({ where: { id: f.session.id }, data: { workerId: f.worker.id } });
      }) });
      const before = await snapshot();
      // Lists inspect the session to choose their branch; a person list is deliberately non-transactional.
      // Revokes admit a person first, then must detect the changed principal in the authority transaction.
      expect((await answer(call(live, c))).code).toBe('FORBIDDEN');
      expect(changed).toBe(1); expect(await snapshot()).toEqual(before);
      await call(live, bound()); expect(await instructionEvents()).toHaveLength(1);
    });

    it(`${name}: session end committed after authorize but before the row fence refuses`, async () => {
      let ended = 0;
      const c = bound({ db: atGrantBoundary(undefined, async () => {
        ended++;
        await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
      }) });
      const before = await snapshot();
      expect((await answer(call(live, c))).code).toBe('FORBIDDEN');
      expect(ended).toBe(1); expect(await snapshot()).toEqual(before);
      await db.session.update({ where: { id: f.session.id }, data: { endedAt: null } });
      await call(live, bound()); expect(await instructionEvents()).toHaveLength(1);
    });

    it(`${name}: App org drift before anchor acquisition refuses even with continuing manager rights`, async () => {
      const next = await db.organization.create({ data: { name: 'Next', urn: 'pins3385.next' } });
      let moved = 0;
      const c = bound({ db: atGrantBoundary(async () => {
        moved++;
        await db.app.update({ where: { id: f.app.id }, data: { organizationId: next.id } });
      }) });
      const before = await snapshot();
      expect((await answer(call(live, c))).code).toBe('FORBIDDEN');
      expect(moved).toBe(1); expect(await snapshot()).toEqual(before);
      await db.app.update({ where: { id: f.app.id }, data: { organizationId: f.org.id } });
      await call(live, bound()); expect(await instructionEvents()).toHaveLength(1);
    });
  }

  for (const name of ['read', 'readList']) it(`${name}: target org drift before anchors refuses even when holder manages both orgs`, async () => {
    const next = await db.organization.create({ data: { name: 'Next', urn: 'pins3385.next' } });
    await db.orgMember.create({ data: { organizationId: next.id, userId: f.holder.id, role: 'ADMIN' } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
    // Separate App's org so its org-admin route cannot mask the target-only predicate.
    const appOrg = await db.organization.create({ data: { name: 'App', urn: 'pins3385.app' } });
    await db.app.update({ where: { id: f.app.id }, data: { organizationId: appOrg.id } });
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    await db.memory.update({ where: { id: f.mem.id }, data: { visibility: 'PUBLIC' } });
    let moved = 0;
    const c = bound({ db: atGrantBoundary(async () => {
      moved++;
      await db.memory.update({ where: { id: f.mem.id }, data: { organizationId: next.id } });
    }) });
    const before = await snapshot();
    expect((await answer(doors[name]!(live, c))).code).toBe('FORBIDDEN');
    expect(moved).toBe(1); expect(await snapshot()).toEqual(before);
    await db.memory.update({ where: { id: f.mem.id }, data: { organizationId: f.org.id } });
    await doors[name]!(live, bound()); expect(await instructionEvents()).toHaveLength(1);
  });
});
