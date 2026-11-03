/**
 * #3311 (S3b of #2483), cor:dmo:050:12 S6, rulings 0098 / 0109 / 0111: listing and revoking an App's credentials is
 * allowed on a holder's instruction, through #3307's one shared check; minting, rotating and giving stay person-only.
 *
 * Doors: revokeAppKey, revokeAppKeyScope, revokeAppGrant, revokeAppMemoryWriteGrant, and the lists appKeys,
 * appKeysPage, appMemoryWriteGrants. The nested App.keys stays refused for a worker session.
 * Records: one AgentTeamEvent per admitted revoke and per admitted instructed list call, ids only (no key, scope or
 * grant id), none for a refusal, a no-op revoke or a direct person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { GRANT_SUBSCRIBE_WORKERS } from '../../../lib/tickers/bounds.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
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
  keys: await db.appKey.findMany({ orderBy: { id: 'asc' } }),
  scopes: await db.appKeyScope.findMany({ orderBy: { id: 'asc' } }),
  grants: await db.appGrant.findMany({ orderBy: { id: 'asc' } }),
  writeGrants: await db.appMemoryWriteGrant.findMany({ orderBy: { id: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
});

const revokes: Record<string, (instruction?: unknown, c?: Context) => Promise<any>> = {
  key: (instruction = live, c = bound()) => M.revokeAppKey({}, { id: f.key.id, instruction }, c),
  scope: (instruction = live, c = bound()) => M.revokeAppKeyScope({}, { id: f.key.id, scope: 'attention:deliver', instruction }, c),
  grant: (instruction = live, c = bound()) => M.revokeAppGrant({}, { appRef: f.app.id, workerRef: f.target.id, name: 'TICKER_SUBSCRIBE_WORKERS', instruction }, c),
  writeGrant: (instruction = live, c = bound()) => M.revokeAppMemoryWriteGrant({}, { id: f.writeGrant.id, instruction }, c),
};
const lists: Record<string, (instruction?: unknown, c?: Context) => Promise<any>> = {
  appKeys: (instruction = live, c = bound()) => Q.appKeys({}, { appRef: f.app.id, instruction }, c),
  appKeysPage: (instruction = live, c = bound()) => Q.appKeysPage({}, { appRef: f.app.id, instruction }, c),
  appMemoryWriteGrants: (instruction = live, c = bound()) => Q.appMemoryWriteGrants({}, { appRef: f.app.id, instruction }, c),
};
const doors = { ...revokes, ...lists };
const isList = (door: string) => door in lists;

beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'cred-holder', roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: 'cred-other', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Cred', urn: 'cred3311.test' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: other.id, role: 'ADMIN' },
  ] });
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
  f = { holder, other, org, app, agent, worker, target, session, key, mem, writeGrant };
});

describe('#3311 instructed revokes and lists', () => {
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
      for (const id of [f.key.id, f.writeGrant.id, f.mem.id, f.target.id]) expect(text).not.toContain(id);
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
        expect(got.code).not.toBe('RESOLVED');
        expect(got.code).toBeDefined(); // a refusal, never a crash
        expect(await snapshot()).toEqual(before);
      });
    }
    it(`${door}: a holder who does not manage the App gets that holder's own refusal, byte-identical`, async () => {
      await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
      const before = await snapshot();
      const worker = await answer(call(live, bound()));
      const person = await answer(call(null, ctx()));
      expect(worker).toEqual(person);
      expect(worker.code).not.toBe('RESOLVED');
      expect(await snapshot()).toEqual(before);
    });
  }

  it('revoke doors take effect: the key, scope, grant and write grant end', async () => {
    for (const door of ['scope', 'grant', 'writeGrant', 'key']) await revokes[door]!();
    expect((await db.appKey.findUniqueOrThrow({ where: { id: f.key.id } })).revokedAt).not.toBeNull();
    expect(await db.appKeyScope.count({ where: { appKeyId: f.key.id, revokedAt: null } })).toBe(0);
    expect(await db.appGrant.count({ where: { appId: f.app.id, revokedAt: null } })).toBe(0);
    expect(await db.appMemoryWriteGrant.count({ where: { appId: f.app.id, revokedAt: null } })).toBe(0);
    expect(await instructionEvents()).toHaveLength(Object.keys(revokes).length);
  });

  it('an unknown scope or an uninstalled App does not tell a refused worker whether the key exists', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    const call = (id: string, scope: string, instruction: unknown) => answer(M.revokeAppKeyScope({}, { id, scope, instruction }, bound()));
    for (const instruction of [live, null]) {
      const missing = await call(generateId(), 'not-a-scope', instruction);
      expect(missing.code).toBe('FORBIDDEN');
      expect(await call(f.key.id, 'not-a-scope', instruction)).toEqual(missing);
    }
    await db.app.update({ where: { id: f.app.id }, data: { uninstalledAt: new Date() } });
    const missing = await call(generateId(), 'attention:deliver', null);
    expect(missing.code).toBe('FORBIDDEN');
    expect(await call(f.key.id, 'attention:deliver', null)).toEqual(missing);
  });

  for (const [kind, extra] of [
    ['impersonation', () => ({ impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } })],
    ['run principal', () => ({ clientId: 'run:test', appId: f.app.id })],
  ] as const) {
    it(`a person under ${kind} (no session) is refused at every revoke and list door`, async () => {
      const before = await snapshot();
      for (const [door, call] of Object.entries(doors)) {
        const got = await answer(call(null, ctx(extra() as any)));
        expect(got.code, door).not.toBe('RESOLVED');
        expect(got.code, door).toBeDefined();
      }
      expect(await snapshot()).toEqual(before);
    });
  }

  it('an instructed revoke is attributed to the holder on the rows it ends', async () => {
    await revokes.grant!(); await revokes.writeGrant!(); await revokes.scope!();
    expect((await db.appGrant.findFirstOrThrow({ where: { appId: f.app.id } })).revokedBy).toBe(f.holder.id);
    expect((await db.appMemoryWriteGrant.findUniqueOrThrow({ where: { id: f.writeGrant.id } })).revokedBy).toBe(f.holder.id);
    expect((await db.appKeyScope.findFirstOrThrow({ where: { appKeyId: f.key.id } })).revokedByUserId).toBe(f.holder.id);
  });

  it('an admitted instructed list returns the rows', async () => {
    expect((await lists.appKeys!()).map((k: any) => k.id)).toContain(f.key.id);
    expect((await lists.appKeysPage!()).items.map((k: any) => k.id)).toContain(f.key.id);
    expect((await lists.appMemoryWriteGrants!()).map((g: any) => g.id)).toContain(f.writeGrant.id);
  });

  // The session row is fenced through commit: a session-end writer cannot commit between the judgement and the write.
  for (const door of ['key', 'scope', 'grant'] as const) {
    it(`${door} revoke fences a concurrent session-end writer until the write commits`, async () => {
      let blocked = false;
      const intercept = async ({ args, query }: any) => {
        try {
          await db.$transaction(async (other) => {
            await other.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
            await other.session.updateMany({ where: { id: f.session.id, endedAt: null }, data: { endedAt: new Date(), endReason: 'expired' } });
          });
        } catch (e: any) { blocked = /lock timeout/.test(String(e.message)); }
        return query(args);
      };
      const query: any = door === 'key' ? { appKey: { updateMany: intercept } } : door === 'scope' ? { appKeyScope: { updateMany: intercept } } : { appGrant: { update: intercept } };
      const client = db.$extends({ query });
      const got = await requestActorStorage.run({ workerId: f.worker.id, agentId: f.agent.id }, () => answer(revokes[door]!(live, bound({ db: client as any }))));
      expect({ blocked, code: got.code }).toEqual({ blocked: true, code: 'RESOLVED' });
      expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).endedAt).toBeNull();
    });
  }

  it('a no-op revoke (already revoked) writes no record', async () => {
    await db.appKeyScope.updateMany({ where: { appKeyId: f.key.id }, data: { revokedAt: new Date(), revokedByUserId: f.holder.id } });
    await db.appMemoryWriteGrant.update({ where: { id: f.writeGrant.id }, data: { revokedAt: new Date(), revokedBy: f.holder.id } });
    await db.appGrant.updateMany({ where: { appId: f.app.id }, data: { revokedAt: new Date(), revokedBy: f.holder.id } });
    for (const door of ['scope', 'grant', 'writeGrant']) await answer(revokes[door]!()); // already ended: nothing changes
    expect(await instructionEvents()).toHaveLength(0);
    await revokes.key!(); // the first key revoke records one
    expect(await instructionEvents()).toHaveLength(1);
    await answer(revokes.key!()); // the same key again is a no-op
    expect(await instructionEvents()).toHaveLength(1);
  });

  it('a refused worker cannot tell a missing key, grant or write grant from an existing one', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    const missing = generateId();
    const pairs: Array<[() => Promise<unknown>, () => Promise<unknown>]> = [
      [() => M.revokeAppKey({}, { id: missing, instruction: live }, bound()), () => M.revokeAppKey({}, { id: f.key.id, instruction: live }, bound())],
      [() => M.revokeAppKeyScope({}, { id: missing, scope: 'attention:deliver', instruction: live }, bound()), () => M.revokeAppKeyScope({}, { id: f.key.id, scope: 'attention:deliver', instruction: live }, bound())],
      [() => M.revokeAppMemoryWriteGrant({}, { id: missing, instruction: live }, bound()), () => M.revokeAppMemoryWriteGrant({}, { id: f.writeGrant.id, instruction: live }, bound())],
      [() => M.revokeAppGrant({}, { appRef: f.app.id, workerRef: generateId(), name: 'TICKER_SUBSCRIBE_WORKERS', instruction: live }, bound()), () => M.revokeAppGrant({}, { appRef: f.app.id, workerRef: f.target.id, name: 'TICKER_SUBSCRIBE_WORKERS', instruction: live }, bound())],
    ];
    for (const [absent, present] of pairs) {
      const a = await answer(absent());
      expect(a.code).not.toBe('RESOLVED');
      expect(a).toEqual(await answer(present()));
    }
  });

  it('App.keys refuses a worker session', async () => {
    const app = await db.app.findUniqueOrThrow({ where: { id: f.app.id } });
    // A nested field carries no instruction: a worker session is refused outright.
    expect((await answer(A.keys(app, {}, bound()))).code).toBe('FORBIDDEN');
  });

  it('person-only acts stay person-only for an instructed worker', async () => {
    const before = await snapshot();
    const tries: Array<() => Promise<unknown>> = [
      () => M.createAppKey({}, { appRef: f.app.id, label: 'x', instruction: live }, bound()),
      () => M.regenerateAppKey({}, { appRef: f.app.id, instruction: live }, bound()),
      () => M.grantAppKeyScope({}, { id: f.key.id, scope: 'attention:deliver', instruction: live }, bound()),
      () => M.grantApp({}, { appRef: f.app.id, workerRef: f.target.id, name: 'TICKER_SUBSCRIBE_WORKERS', instruction: live }, bound()),
      () => M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.mem.id, prefix: 'reports:y', instruction: live }, bound()),
    ];
    for (const t of tries) expect((await answer(t())).code).not.toBe('RESOLVED');
    expect(await snapshot()).toEqual(before);
  });

  it('the instructed write-grant list shows no grant on a memory the holder may not see', async () => {
    const priv = await db.memory.create({ data: { name: 'priv', urn: 'cred3311.test:priv', class: 'private', userId: f.other.id, organizationId: f.org.id } as never });
    await db.appMemoryWriteGrant.create({ data: { appId: f.app.id, memoryId: priv.id, prefix: 'p:q', grantedBy: f.other.id } });
    const rows = await lists.appMemoryWriteGrants();
    expect(rows).toHaveLength(1);
  });
});
