/**
 * #3774 — uninstallApp / reinstallApp (cor:dmo:050:21; Holger R1-R3, 2026-11-09). Acceptance A1-A7 of the gate.
 * Each pin is red on main: no operation sets or clears `App.uninstalledAt`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { evaluateDarkWorkers } from '../../../lib/agentTasks/darkWorker.js';
import { resolvers, type Context } from './resolvers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

async function code(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    // MemoryNotFoundError (a memory write) is not a GraphQLError: it carries its code on the error itself.
    const err = e as GraphQLError & { code?: string };
    return { code: err.extensions?.code ?? err.code, message: err.message };
  }
  throw new Error('expected a rejection');
}

let n = 0;
const mkUser = (label: string, extra: Record<string, unknown> = {}) =>
  db.user.create({ data: { githubId: 8_000_000 + ++n, githubUsername: `un-${label}-${generateId()}`, roles: ['READER'], ...extra }, select: { id: true } });

let org: { id: string; urn: string };
let otherOrg: { id: string };
let admin: { id: string }, orgOwner: { id: string }, orgMember: { id: string }, otherAdmin: { id: string };
let appOwnerRole: { id: string }, platformAdmin: { id: string }, stranger: { id: string };
let app: { id: string; urn: string };
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'un-org', urn: `un-${generateId().toLowerCase()}.example` } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'un-other', urn: `uo-${generateId().toLowerCase()}.example` } });
  [admin, orgOwner, orgMember, otherAdmin, appOwnerRole, stranger] = await Promise.all(
    ['ad', 'ow', 'me', 'oa', 'ar', 'st'].map((l) => mkUser(l)),
  );
  platformAdmin = await mkUser('pa', { roles: ['ADMIN'] });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgOwner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgMember.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: otherAdmin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Un Agent' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Un', urn: `${org.urn}:un` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: appOwnerRole.id, role: 'owner' } });
});

const row = () => db.app.findUniqueOrThrow({ where: { id: app.id } });

async function worker(appId: string, name: string) {
  return db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name, slug: name.toLowerCase() }, select: { id: true } });
}
async function openEpisode(appId: string, workerId: string, openedAt = new Date('2026-11-01T00:00:00Z')) {
  const eventId = generateId();
  await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, subject_worker_id, severity, chain, payload, created_at)
    VALUES (${eventId}, ${appId}, 'alarm.dark-worker', ${workerId}, 'alarm', '[]'::jsonb, '{}'::jsonb, ${openedAt}::timestamp)`;
  return db.darkWorkerEpisode.create({ data: { appId, workerId, eventId, reason: 'overdue', openedAt } });
}

describe('#3774 uninstallApp', () => {
  it('A1: the gate caller uninstalls; writes through the App are then refused APP_UNINSTALLED', async () => {
    expect(await M.uninstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    expect((await row()).uninstalledAt).toBeInstanceOf(Date);
    const refused = await code(M.installAgentIntoApp({}, { appRef: app.id, agentRef: agentId }, ctx(admin.id)));
    expect(refused.code).toBe('APP_UNINSTALLED');
  });

  it('A1: resolves by URN too', async () => {
    expect(await M.uninstallApp({}, { ref: app.urn }, ctx(orgOwner.id))).toBe(true);
    expect((await row()).uninstalledAt).not.toBeNull();
  });

  it('A2: platform admin and org ADMIN/OWNER succeed; nobody else does, with one byte-identical refusal', async () => {
    const ghost = await code(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    for (const who of [orgMember.id, otherAdmin.id, appOwnerRole.id, stranger.id, undefined]) {
      const r = await code(M.uninstallApp({}, { ref: app.id }, ctx(who)));
      expect(r).toEqual(ghost);
      expect((await row()).uninstalledAt).toBeNull();
    }
    expect(await M.uninstallApp({}, { ref: app.id }, ctx(platformAdmin.id, ['ADMIN']))).toBe(true);
  });

  it('A2: a user-owned App is owner-only', async () => {
    const mine = await db.app.create({ data: { id: generateId(), ownerUserId: stranger.id, name: 'Mine', urn: `un-mine-${generateId().toLowerCase()}` } });
    expect((await code(M.uninstallApp({}, { ref: mine.id }, ctx(platformAdmin.id, ['ADMIN'])))).code).toBeTruthy();
    expect((await db.app.findUniqueOrThrow({ where: { id: mine.id } })).uninstalledAt).toBeNull();
    expect(await M.uninstallApp({}, { ref: mine.id }, ctx(stranger.id))).toBe(true);
  });

  it('A3: ends this App\'s open dark-worker episodes, leaves another App\'s open', async () => {
    const w = await worker(app.id, 'Ada');
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const ow = await worker(other.id, 'Bea');
    const mine = await openEpisode(app.id, w.id);
    const theirs = await openEpisode(other.id, ow.id);
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    const stamp = (await row()).uninstalledAt!;
    expect((await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: mine.id } })).endedAt?.getTime()).toBe(stamp.getTime());
    expect((await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: theirs.id } })).endedAt).toBeNull();
  });

  it('A3: one transaction — a failing episode end leaves the App installed', async () => {
    const w = await worker(app.id, 'Ada');
    const ep = await openEpisode(app.id, w.id);
    await db.$executeRawUnsafe(`CREATE FUNCTION un3774_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER un3774_boom BEFORE UPDATE ON dark_worker_episodes FOR EACH ROW EXECUTE FUNCTION un3774_boom()`);
    try {
      await expect(M.uninstallApp({}, { ref: app.id }, ctx(admin.id))).rejects.toBeTruthy();
      expect((await row()).uninstalledAt).toBeNull();
      expect((await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: ep.id } })).endedAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER un3774_boom ON dark_worker_episodes');
      await db.$executeRawUnsafe('DROP FUNCTION un3774_boom()');
    }
  });

  it('A5: a repeat uninstall is a no-op (one stamp)', async () => {
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    const first = (await row()).uninstalledAt!;
    expect(await M.uninstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    expect((await row()).uninstalledAt!.getTime()).toBe(first.getTime());
  });

  it('A5: a repeat uninstall ends no episode (it does nothing at all)', async () => {
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    const w = await worker(app.id, 'Ada');
    const ep = await openEpisode(app.id, w.id);
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    expect((await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: ep.id } })).endedAt).toBeNull();
  });

  it('A6: a deleted App refuses uninstall', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    await code(M.uninstallApp({}, { ref: app.id }, ctx(admin.id)));
    expect((await row()).uninstalledAt).toBeNull();
  });
});

describe('#3774 reinstallApp', () => {
  beforeEach(async () => { await M.uninstallApp({}, { ref: app.id }, ctx(admin.id)); });

  it('A4: reinstalls the SAME row (id, members) and writes work again', async () => {
    const before = await row();
    expect(await M.reinstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    const after = await row();
    expect(after.uninstalledAt).toBeNull();
    expect(after.id).toBe(before.id);
    expect(await db.appMember.count({ where: { appId: app.id } })).toBe(1);
    expect(await db.app.count({ where: { urn: app.urn } })).toBe(1);
    // the write the uninstall refused succeeds again
    const again = await M.installAgentIntoApp({}, { appRef: app.id, agentRef: agentId }, ctx(admin.id));
    expect(again.appAgent.appId).toBe(app.id);
  });

  it('a repeat by URN reaches the same App (no-op), and never retargets a historical uninstalled App with the handle', async () => {
    const historical = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Old', urn: app.urn, uninstalledAt: new Date('2026-01-01T00:00:00Z') } });
    // two uninstalled holders: a URN is ambiguous, one identical refusal
    expect((await code(M.reinstallApp({}, { ref: app.urn }, ctx(admin.id)))).code).toBe('FORBIDDEN');
    expect(await M.reinstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    expect(await M.reinstallApp({}, { ref: app.urn }, ctx(admin.id))).toBe(true); // names the installed holder: no-op
    expect(await M.uninstallApp({}, { ref: app.urn }, ctx(admin.id))).toBe(true);
    expect((await row()).uninstalledAt).not.toBeNull(); // uninstalled the holder, not the historical row
    expect(await M.uninstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    // the historical row is untouched by any of it, and by-id reinstall of it is refused while the handle is held
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    expect((await code(M.reinstallApp({}, { ref: historical.id }, ctx(admin.id)))).code).toBe('APP_URN_IN_USE');
    expect((await db.app.findUniqueOrThrow({ where: { id: historical.id } })).uninstalledAt!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('the handle-taken refusal carries appId and urn', async () => {
    await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Taker', urn: app.urn } });
    try { await M.reinstallApp({}, { ref: app.id }, ctx(admin.id)); expect.unreachable(); } catch (e) {
      expect((e as GraphQLError).extensions).toMatchObject({ code: 'APP_URN_IN_USE', appId: app.id, urn: app.urn });
    }
  });

  it('A4: refused APP_URN_IN_USE while another installed App holds the handle; both unchanged', async () => {
    const taker = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Taker', urn: app.urn } });
    const r = await code(M.reinstallApp({}, { ref: app.id }, ctx(admin.id)));
    expect(r.code).toBe('APP_URN_IN_USE');
    expect((await row()).uninstalledAt).not.toBeNull();
    expect((await db.app.findUniqueOrThrow({ where: { id: taker.id } })).uninstalledAt).toBeNull();
  });

  it('A2: the same gate; refusals byte-identical to a missing App', async () => {
    const ghost = await code(M.reinstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    for (const who of [orgMember.id, otherAdmin.id, appOwnerRole.id, stranger.id, undefined]) {
      expect(await code(M.reinstallApp({}, { ref: app.id }, ctx(who)))).toEqual(ghost);
    }
    expect((await row()).uninstalledAt).not.toBeNull();
    expect(await M.reinstallApp({}, { ref: app.id }, ctx(orgOwner.id))).toBe(true);
  });

  it('A5: a repeat reinstall of an installed App is a no-op', async () => {
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    expect(await M.reinstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    expect((await row()).uninstalledAt).toBeNull();
  });

  it('A5: concurrent uninstall and reinstall leave the stamp and the episode closure coherent', async () => {
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    for (let i = 0; i < 4; i++) {
      const w = await worker(app.id, `W${i}`);
      const ep = await openEpisode(app.id, w.id);
      await Promise.all([M.uninstallApp({}, { ref: app.id }, ctx(admin.id)), M.reinstallApp({}, { ref: app.id }, ctx(admin.id))]);
      const r = await row();
      const e = await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: ep.id } });
      // uninstall ran after the reinstall <=> the App is uninstalled AND the episode was ended; otherwise the episode was ended
      // by the uninstall that ran first or is still open with the App installed. Never: uninstalled with an open episode.
      if (r.uninstalledAt) expect(e.endedAt).not.toBeNull();
      await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    }
  });

  it('A6: deleted-while-uninstalled refuses reinstall (no undelete)', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    await code(M.reinstallApp({}, { ref: app.id }, ctx(admin.id)));
    expect((await row()).uninstalledAt).not.toBeNull();
  });

  it('A7: an episode the uninstall ended stays ended after a reinstall; the sweep sees the App again and never reopens it', async () => {
    // (the beforeEach uninstalled before any episode existed, so seed one, end it as an uninstall would, then reinstall)
    const w = await worker(app.id, 'Ada');
    const old = await openEpisode(app.id, w.id);
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    expect((await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: old.id } })).endedAt).not.toBeNull();
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    await evaluateDarkWorkers(db, new Date());
    expect((await db.darkWorkerEpisode.findUniqueOrThrow({ where: { id: old.id } })).endedAt).not.toBeNull();
    // any episode open now is a different row from the one the uninstall ended
    const openNow = await db.darkWorkerEpisode.findMany({ where: { workerId: w.id, endedAt: null } });
    expect(openNow.every((e) => e.id !== old.id)).toBe(true);
  });
});

describe('#3774 the in-transaction gate re-check (revocation race)', () => {
  /** A db whose FIRST orgMember.findFirst (the outer gate) reads truthfully, then revokes the caller's membership. */
  function revokedAfterOuterGate(userId: string): Context['db'] {
    let fired = false;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'orgMember') {
          return new Proxy(target.orgMember, {
            get(t, p) {
              if (p === 'findFirst') {
                return async (...a: unknown[]) => {
                  const r = await (t as any).findFirst(...a);
                  if (!fired) { fired = true; await db.orgMember.updateMany({ where: { userId }, data: { deletedAt: new Date() } }); }
                  return r;
                };
              }
              const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Context['db'];
  }

  it('uninstall: an admin revoked after the outer gate is refused and nothing is stamped', async () => {
    const racer = await mkUser('race');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: racer.id, role: 'ADMIN' } });
    await code(M.uninstallApp({}, { ref: app.id }, { db: revokedAfterOuterGate(racer.id), userId: racer.id, roles: ['READER'] }));
    expect((await row()).uninstalledAt).toBeNull();
  });

  it('reinstall: the same race', async () => {
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    const racer = await mkUser('race2');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: racer.id, role: 'ADMIN' } });
    await code(M.reinstallApp({}, { ref: app.id }, { db: revokedAfterOuterGate(racer.id), userId: racer.id, roles: ['READER'] }));
    expect((await row()).uninstalledAt).not.toBeNull();
  });
});

describe('#3774 A1/A4 the gate-named write families: refused while uninstalled, served again after a reinstall, same row', () => {
  it('task create, app-memory create, session start and agent install', async () => {
    const w = await worker(app.id, 'Kit');
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    await serveEveryAgent(db); // binds are served the Agent's boot prompt
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'hdr_app_x…', label: 'k' } });
    const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, urn: `${org.urn}:keep`, name: 'keep', class: 'app' } });
    const attempts = {
      task: () => M.createAgentTask({}, { input: { appRef: app.id, title: 'T3774' } }, ctx(admin.id)),
      appMemory: () => M.createAppMemory({}, { appRef: app.id, name: 'am3774' }, ctx(admin.id)),
      session: () => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: w.id, description: 's' } }, ctx(admin.id)),
      memoryWrite: () => M.createNode(null, { input: { memoryId: mem.id, loc: `n${generateId().slice(-6).toLowerCase()}`, name: 'n', content: 'c' } }, ctx(admin.id)),
      install: () => M.installAgentIntoApp({}, { appRef: app.id, agentRef: agentId }, ctx(admin.id)),
    };
    await M.uninstallApp({}, { ref: app.id }, ctx(admin.id));
    // Every family refuses.
    for (const [family, attempt] of Object.entries(attempts)) {
      const r = await code(attempt());
      expect([family, ['APP_UNINSTALLED', 'FORBIDDEN', 'MEMORY_NOT_FOUND'].includes(String(r.code))]).toEqual([family, true]);
    }
    expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(0);
    expect(await db.session.count({ where: { appId: app.id } })).toBe(0);
    const before = await row();
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    // Same row, same members, same memory, same key; and every family serves again.
    const after = await row();
    expect(after.id).toBe(before.id);
    expect(await db.appMember.count({ where: { appId: app.id, userId: appOwnerRole.id } })).toBe(1);
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).appId).toBe(app.id);
    expect((await db.appKey.findUniqueOrThrow({ where: { id: key.id } })).appId).toBe(app.id);
    for (const [family, attempt] of Object.entries(attempts)) {
      if (family === 'install') {
        // The Agent is already installed in this fixture (DUPLICATE_APP_AGENT); the pin is that the UNINSTALL cause is gone.
        const r = await attempt().then(() => null, (e: unknown) => (e as GraphQLError).extensions?.code);
        expect(r, family).not.toBe('APP_UNINSTALLED');
        continue;
      }
      await expect(attempt(), family).resolves.toBeTruthy();
    }
  });
});
