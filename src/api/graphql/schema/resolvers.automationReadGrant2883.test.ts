/**
 * #2883 (ruling 0081 = A, cor:agt:010:01): an automation's READ grant, held on the trigger row a run executes.
 *
 * Red first: on main there is no grant table, no give / revoke / list door and no read arm in the run `hadron_read_node`
 * read, so every case that needs the grant fails there. Cases marked CONTROL are green on main by design: they pin
 * authority that must NOT change when the grant lands.
 *
 * The target used throughout is the system memory of the SECOND-installed Agent: the run fold reads only the
 * first-installed Agent's system memory (findings:run-fold-reads-only-first-installed-agent, #3233), so the second is
 * refused by the shared gate and only the grant can admit it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { hadronReadNode } from '../../../lib/runner/tools/nodeTools.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const ENTRY = 'hrn:node:example.com:m:flows:entry';

interface F {
  org: { id: string; urn: string }; app: { id: string }; otherApp: { id: string };
  admin: { id: string }; member: { id: string }; outsider: { id: string }; appOwner: { id: string };
  first: { id: string; systemMemoryId: string }; second: { id: string; systemMemoryId: string };
  s1: { id: string }; s2: { id: string };
  sysUrn: string; adminCtx: Context; memberCtx: Context; outsiderCtx: Context; appOwnerCtx: Context;
}
let f: F;

const uctx = (userId: string) => ({ db, userId, roles: ['READER'] }) as unknown as Context;
const schedule = (appId: string, orgId: string) => db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY } });
const run = (kind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' | 'SPAWN', triggerId: string | null, parentRunId: string | null = null, userId: string | null = null) =>
  db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, triggerKind: kind, triggerId, parentRunId, userId, entryNodeUrn: ENTRY } });
const node = (memoryId: string, loc: string) => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`, nodeType: 'record' } as never });

/** The run's `hadron_read_node`, exactly as the kernel calls it. */
async function readAs(r: { id: string; appId: string; userId: string | null }, memoryUrn: string, loc: string) {
  const runRow = await db.appRun.findUniqueOrThrow({ where: { id: r.id } });
  const principal = { db, appId: r.appId, userId: r.userId ?? undefined, organizationId: f.org.id, clientId: `${RUN_CLIENT_PREFIX}${r.id}`, roles: [] } as unknown as Context;
  return hadronReadNode.execute({ log: () => undefined, db, run: runRow, principal } as never, { urn: `hrn:node:${memoryUrn}:${loc}` });
}
const give = (c: Context = f.adminCtx, o: Partial<{ triggerId: string; triggerKind: string; memoryRef: string; prefix: string | null; appRef: string }> = {}) =>
  M.setAutomationReadGrant({}, { appRef: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.s1.id, memoryRef: f.second.systemMemoryId, prefix: 'tasks', ...o }, c);
const readable = async (r: { id: string; appId: string; userId: string | null }, loc = 'tasks:report') => {
  try { await readAs(r, f.sysUrn, loc); return true; } catch (e) { if (/not readable/.test((e as Error).message)) return false; throw e; }
};
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'RG Org', urn: `rg-${generateId().toLowerCase()}.example` } });
  const mk = async (h: string) => db.user.create({ data: { id: generateId(), name: h, handle: `${h}-${generateId().slice(-6).toLowerCase()}`, roles: ['READER'] } });
  const [admin, member, outsider, appOwner] = await Promise.all([mk('admin'), mk('member'), mk('outsider'), mk('appowner')]);
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'READER' } });
  const adminCtx = uctx(admin.id);
  const first = await M.createAgent({}, { orgId: org.id, name: 'First' }, adminCtx);
  const second = await M.createAgent({}, { orgId: org.id, name: 'Second' }, adminCtx);
  const { app } = await createDbAppWithKey(db, 'rg-app', org.id);
  const { app: otherApp } = await createDbAppWithKey(db, 'rg-other', org.id);
  await createDbAppAgent(db, app.id, first.id);
  await new Promise((r) => setTimeout(r, 5));
  await createDbAppAgent(db, app.id, second.id);
  await db.appMember.create({ data: { appId: app.id, userId: appOwner.id, role: 'owner' } });
  const sys = await db.memory.findUniqueOrThrow({ where: { id: second.systemMemoryId }, select: { urn: true } });
  const s1 = await schedule(app.id, org.id);
  const s2 = await schedule(app.id, org.id);
  f = { org, app, otherApp, admin, member, outsider, appOwner, first, second, s1, s2, sysUrn: sys.urn,
    adminCtx, memberCtx: uctx(member.id), outsiderCtx: uctx(outsider.id), appOwnerCtx: uctx(appOwner.id) };
  await node(second.systemMemoryId, 'tasks:report');
  await node(second.systemMemoryId, 'tasks:reportX');
  await node(second.systemMemoryId, 'other:x');
});

describe('give and revoke', () => {
  it('CONTROL: before any grant the run is refused the second Agent\'s system memory', async () => {
    expect(await readable(await run('SCHEDULE', f.s1.id))).toBe(false);
  });

  it('after give the run reads the prefix; after revoke the next read is refused', async () => {
    const r = await run('SCHEDULE', f.s1.id);
    const g = await give();
    expect(g).toMatchObject({ triggerKind: 'SCHEDULE', triggerId: f.s1.id, prefix: 'tasks', revokedAt: null });
    expect(((await readAs(r, f.sysUrn, 'tasks:report')) as { content: string }).content).toBe('body of tasks:report');
    await M.revokeAutomationReadGrant({}, { id: g.id }, f.adminCtx);
    expect(await readable(r)).toBe(false);
  });

  it('a grant carries over an edit and a re-adoption (the pin on the same row is rewritten); a deleted trigger ends it (0081 A)', async () => {
    const r = await run('SCHEDULE', f.s1.id);
    await give();
    await db.agentSchedule.update({ where: { id: f.s1.id }, data: { automationPin: { rewritten: true } as never, cron: '5 * * * *' } });
    expect(await readable(r)).toBe(true);
    await db.agentSchedule.update({ where: { id: f.s1.id }, data: { deletedAt: new Date() } });
    expect(await readable(r)).toBe(false);
  });

  it('is idempotent: the same give twice is one live row and one GRANT event', async () => {
    const a = await give();
    const b = await give();
    expect(b.id).toBe(a.id);
    expect(await db.appAutomationReadGrant.count()).toBe(1);
    expect(await db.appAutomationReadGrantEvent.count({ where: { action: 'GRANT' } })).toBe(1);
  });

  it('a whole-memory grant (no prefix) reads every node; a prefix covers itself and its descendants, never a sibling', async () => {
    const r = await run('SCHEDULE', f.s1.id);
    const g = await give(f.adminCtx, { prefix: 'tasks:report' });
    expect(await readable(r, 'tasks:report')).toBe(true);
    expect(await readable(r, 'tasks:reportX')).toBe(false);
    expect(await readable(r, 'other:x')).toBe(false);
    await M.revokeAutomationReadGrant({}, { id: g.id }, f.adminCtx);
    await give(f.adminCtx, { prefix: null });
    expect(await readable(r, 'other:x')).toBe(true);
  });

  it('a malformed prefix is BAD_USER_INPUT before any lookup', async () => {
    await expect(give(f.adminCtx, { prefix: 'a::b', appRef: generateId() })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(give(f.adminCtx, { triggerKind: 'NOPE' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('scope: only the granted automation', () => {
  it('another automation of the same App, a MANUAL run and a bare App key are refused (CONTROL for the key)', async () => {
    await give();
    expect(await readable(await run('SCHEDULE', f.s2.id))).toBe(false);
    expect(await readable(await run('MANUAL', null))).toBe(false);
    const key = { appId: f.app.id, appKeyId: generateId(), organizationId: f.org.id, roles: [] } as never;
    expect(await canReadMemory(db, key, f.second.systemMemoryId)).toBe(false);
  });

  it('runs the trigger starts carry the root trigger\'s grant (SPAWN child); a webhook with the same id string does not', async () => {
    await give();
    const root = await run('SCHEDULE', f.s1.id);
    const child = await run('SPAWN', root.id, root.id);
    expect(await readable(child)).toBe(true);
    const wh = await db.agentWebhook.create({ data: { id: f.s1.id + 'w', organizationId: f.org.id, appId: f.app.id, name: 'W', secret: generateId(), entryNodeUrn: ENTRY } });
    expect(await readable(await run('WEBHOOK', wh.id))).toBe(false);
  });

  it('a user-backed run still needs the user layer: a run on behalf of a user who cannot read the memory is refused', async () => {
    await give();
    expect(await readable(await run('SCHEDULE', f.s1.id, null, f.outsider.id))).toBe(false);
  });
});

describe('what may be a target', () => {
  it('an Agent not installed in the App, personal, private, encrypted and cap-exceeding targets are refused at give; byte-identical to unknown', async () => {
    const notInstalled = await M.createAgent({}, { orgId: f.org.id, name: 'Not installed' }, f.adminCtx);
    const personal = await db.memory.create({ data: { id: generateId(), name: 'p', urn: `t:${generateId().toLowerCase()}`, class: 'personal', userId: f.admin.id, ownerUserId: f.admin.id } as never });
    const priv = await db.memory.create({ data: { id: generateId(), name: 'q', urn: `t:${generateId().toLowerCase()}`, class: 'private', userId: f.admin.id, ownerUserId: f.admin.id } as never });
    const enc = await db.memory.create({ data: { id: generateId(), name: 'e', urn: `t:${generateId().toLowerCase()}`, class: 'knowledge', organizationId: f.org.id, visibility: 'ORGANIZATION', isEncrypted: true } as never });
    const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'F', urn: `f-${generateId().toLowerCase()}.example` } });
    const foreign = await db.memory.create({ data: { id: generateId(), name: 'f', urn: `t:${generateId().toLowerCase()}`, class: 'knowledge', organizationId: foreignOrg.id, visibility: 'ORGANIZATION' } as never });
    for (const id of [notInstalled.systemMemoryId, personal.id, priv.id, enc.id, foreign.id, generateId()]) {
      await forbidden(give(f.adminCtx, { memoryRef: id }));
    }
    expect(await db.appAutomationReadGrant.count()).toBe(0);
  });

  it('uninstalling the Agent after the grant stops the read (judged live)', async () => {
    const r = await run('SCHEDULE', f.s1.id);
    await give();
    await db.appAgent.deleteMany({ where: { appId: f.app.id, agentId: f.second.id } });
    expect(await readable(r)).toBe(false);
  });

  it('an uninstalled App stops the read (judged live)', async () => {
    const r = await run('SCHEDULE', f.s1.id);
    await give();
    await db.app.update({ where: { id: f.app.id }, data: { uninstalledAt: new Date() } });
    expect(await readable(r)).toBe(false);
  });

  it('a trigger of another App, a missing trigger and a deleted trigger are refused at give', async () => {
    const foreign = await schedule(f.otherApp.id, f.org.id);
    await forbidden(give(f.adminCtx, { triggerId: foreign.id }));
    await forbidden(give(f.adminCtx, { triggerId: generateId() }));
    await db.agentSchedule.update({ where: { id: f.s1.id }, data: { deletedAt: new Date() } });
    await forbidden(give());
  });

  it('the grant is read-only: a write through it is refused and writes nothing', async () => {
    await give();
    const r = await run('SCHEDULE', f.s1.id);
    const runRow = await db.appRun.findUniqueOrThrow({ where: { id: r.id } });
    const principal = { db, appId: f.app.id, organizationId: f.org.id, clientId: `${RUN_CLIENT_PREFIX}${r.id}`, roles: [] } as unknown as Context;
    const { hadronCreateNode } = await import('../../../lib/runner/tools/nodeTools.js');
    const before = await db.node.count({ where: { memoryId: f.second.systemMemoryId } });
    await expect(hadronCreateNode.execute({ log: () => undefined, db, run: runRow, principal } as never,
      { urn: `hrn:node:${f.sysUrn}:tasks:new`, name: 'n' })).rejects.toBeTruthy();
    expect(await db.node.count({ where: { memoryId: f.second.systemMemoryId } })).toBe(before);
  });
});

describe('who may give, revoke and list', () => {
  it('only the Agent\'s manager gives a system-memory grant: a plain org member, an App owner who is not the Agent\'s manager, an outsider and a run are refused, byte-identically', async () => {
    await forbidden(give(f.memberCtx));
    await forbidden(give(f.outsiderCtx));
    await forbidden(give(f.appOwnerCtx));
    await forbidden(give({ ...f.adminCtx, clientId: `${RUN_CLIENT_PREFIX}x` } as Context));
    await forbidden(give({ ...f.adminCtx, impersonation: { sessionId: 's', actorUserId: f.admin.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } } as unknown as Context));
    await forbidden(give(f.adminCtx, { appRef: generateId() }));
    expect(await db.appAutomationReadGrant.count()).toBe(0);
  });

  it('another class: the memory\'s manager gives; a non-manager does not', async () => {
    const know = await db.memory.create({ data: { id: generateId(), name: 'k', urn: `t:${generateId().toLowerCase()}`, class: 'knowledge', organizationId: f.org.id, visibility: 'ORGANIZATION' } as never });
    await forbidden(give(f.memberCtx, { memoryRef: know.id }));
    expect(await give(f.adminCtx, { memoryRef: know.id })).toMatchObject({ prefix: 'tasks' });
  });

  it('revoke: the App\'s manager or the target\'s manager; nobody else; unknown id is the same Forbidden', async () => {
    const g = await give();
    await forbidden(M.revokeAutomationReadGrant({}, { id: g.id }, f.outsiderCtx));
    await forbidden(M.revokeAutomationReadGrant({}, { id: g.id }, f.memberCtx));
    await forbidden(M.revokeAutomationReadGrant({}, { id: generateId() }, f.adminCtx));
    const done = await M.revokeAutomationReadGrant({}, { id: g.id }, f.appOwnerCtx);
    expect(done.revokedBy).toBe(f.appOwner.id);
    const again = await M.revokeAutomationReadGrant({}, { id: g.id }, f.adminCtx);
    expect(again.revokedBy).toBe(f.appOwner.id); // terminal: the second revoke changes and records nothing
    expect(await db.appAutomationReadGrantEvent.count({ where: { action: 'REVOKE' } })).toBe(1);
  });

  it('the target\'s manager needs no App role: an Agent of another org, installed here, is given, listed and revoked by ITS manager alone', async () => {
    const orgB = await db.organization.create({ data: { id: generateId(), name: 'B', urn: `b-${generateId().toLowerCase()}.example` } });
    const bAdmin = await db.user.create({ data: { id: generateId(), name: 'badmin', handle: `b-${generateId().slice(-6).toLowerCase()}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: orgB.id, userId: bAdmin.id, role: 'ADMIN' } });
    const bAgent = await M.createAgent({}, { orgId: orgB.id, name: 'B agent' }, uctx(bAdmin.id));
    await createDbAppAgent(db, f.app.id, bAgent.id);
    const bCtx = uctx(bAdmin.id);
    const g = await give(bCtx, { memoryRef: bAgent.systemMemoryId });
    expect((await Q.automationReadGrants({}, { memoryRef: bAgent.systemMemoryId }, bCtx)).map((x: any) => x.id)).toEqual([g.id]);
    const other = await give(); // org A's own grant in the same App: not B's to see
    expect((await Q.automationReadGrants({}, { appRef: f.app.id }, bCtx)).map((x: any) => x.id)).toEqual([g.id]);
    expect(other.id).not.toBe(g.id);
    await forbidden(M.revokeAutomationReadGrant({}, { id: g.id }, f.memberCtx));
    expect((await M.revokeAutomationReadGrant({}, { id: g.id }, bCtx)).revokedBy).toBe(bAdmin.id);
  });

  it('list: App managers see the App\'s grants; the target\'s manager sees the grants on what they manage; no one else sees any', async () => {
    const g = await give();
    const byApp = await Q.automationReadGrants({}, { appRef: f.app.id }, f.appOwnerCtx);
    expect(byApp.map((x: any) => x.id)).toEqual([g.id]);
    const byMemory = await Q.automationReadGrants({}, { memoryRef: f.second.systemMemoryId }, f.adminCtx);
    expect(byMemory.map((x: any) => x.id)).toEqual([g.id]);
    expect(await Q.automationReadGrants({}, { appRef: f.app.id }, f.outsiderCtx)).toEqual([]);
    expect(await Q.automationReadGrants({}, { appRef: f.app.id }, f.memberCtx)).toEqual([]);
    expect(await Q.automationReadGrants({}, { memoryRef: f.second.systemMemoryId }, f.outsiderCtx)).toEqual([]);
    await M.revokeAutomationReadGrant({}, { id: g.id }, f.adminCtx);
    expect(await Q.automationReadGrants({}, { appRef: f.app.id }, f.appOwnerCtx)).toEqual([]);
    expect((await Q.automationReadGrants({}, { appRef: f.app.id, includeRevoked: true }, f.appOwnerCtx))).toHaveLength(1);
  });
});

describe('audit', () => {
  it('give and revoke each write one content-free event naming the actor', async () => {
    const g = await give();
    await M.revokeAutomationReadGrant({}, { id: g.id }, f.adminCtx);
    const ev = await db.appAutomationReadGrantEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(ev.map((e) => e.action)).toEqual(['GRANT', 'REVOKE']);
    for (const e of ev) {
      expect(e).toMatchObject({ appId: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.s1.id, memoryId: f.second.systemMemoryId, grantId: g.id, prefix: 'tasks', actorUserId: f.admin.id });
      expect(Object.keys(e).sort()).toEqual(['action', 'actorUserId', 'appId', 'createdAt', 'grantId', 'id', 'memoryId', 'prefix', 'triggerId', 'triggerKind']);
    }
  });

  it('the event is written in the same transaction: when it fails, no grant row remains', async () => {
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION t_fail_ev() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'event insert refused'; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER t_fail_ev_trg BEFORE INSERT ON app_automation_read_grant_events FOR EACH ROW EXECUTE FUNCTION t_fail_ev()');
    try {
      await expect(give()).rejects.toBeTruthy();
      expect(await db.appAutomationReadGrant.count()).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER t_fail_ev_trg ON app_automation_read_grant_events');
      await db.$executeRawUnsafe('DROP FUNCTION t_fail_ev()');
    }
  });
});
