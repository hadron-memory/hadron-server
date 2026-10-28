import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1761 + #1762 — whoever manages the App is in a root task's alarm chain
 * (cor:agt:050:25, :18) and may acknowledge any alarm in the App (cor:agt:050:24).
 *
 * One list of managers (`appManagerUserIds`) feeds the chain; `managesApp` gates
 * the acknowledgement; a differential test pins that they name the same people.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { ownerChain } from './stall.js';
import { appManagerUserIds, managesApp } from '../auth/appManagement.js';
import { mergeUsers } from '../../test/mergeConsent.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;

const at = (hhmm: string): Date => new Date(`2026-10-09T${hhmm}:00Z`);
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let n = 0;
const mkUser = (label: string, extra: Record<string, unknown> = {}) =>
  db.user.create({ data: { githubId: 7_000_000 + ++n, githubUsername: `am-${label}-${generateId()}`, roles: ['READER'], ...extra }, select: { id: true } });

let org: { id: string; urn: string };
let app: { id: string; organizationId: string | null; ownerUserId: string | null };
let agentId: string;
let ada: { id: string };
let anne: { id: string };
let orgAdmin: { id: string };
let orgOwner: { id: string };
let appOwnerMember: { id: string };
let plain: { id: string };
let platformAdmin: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'am-org', urn: `am-${generateId().toLowerCase()}.example` } });
  [orgAdmin, orgOwner, appOwnerMember, plain] = [await mkUser('oa'), await mkUser('oo'), await mkUser('ao'), await mkUser('pl')];
  platformAdmin = await mkUser('pa', { roles: ['ADMIN'] });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgOwner.id, role: 'OWNER' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(orgAdmin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: appOwnerMember.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: plain.id, role: 'member' } });
  const w = (name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } });
  ada = await w('Ada');
  anne = await w('Anne');
});

const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { id: generateId(), appId: app.id, title: 'T', createdAt: at('09:00'), ...data } as any, select: { id: true } });
const alarmsList = () => db.agentTeamEvent.findMany({ where: { severity: 'alarm' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const wakes = (eventId: string) => db.agentTeamAlarmSchedule.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });

/** A root task owned by Ada, assigned to Anne and never started: one not-started alarm at 10:15. */
async function rootAlarm(extra: Record<string, unknown> = {}) {
  const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('10:00'), createdAt: at('10:00'), ...extra });
  await taskStallTick(db, at('10:15'));
  const [a] = await alarmsList();
  return { t, a };
}

describe('#1761 — a root task\'s alarm chain continues to the App\'s managers (cor:agt:050:25)', () => {
  it('lists the owner, then the App-owner members, then the org admins/owners, each once', async () => {
    const { a } = await rootAlarm();
    const ids = (a.chain as { workerId?: string; userId?: string }[]);
    expect(ids[0]).toEqual({ workerId: ada.id });
    expect(ids.slice(1)).toEqual([
      { userId: appOwnerMember.id, via: 'manager' },
      ...[orgAdmin.id, orgOwner.id].sort().map((userId) => ({ userId, via: 'manager' })),
    ]);
  });

  it('leaves out plain members, platform admins, removed org members and deleted users', async () => {
    const gone = await mkUser('gone');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: gone.id, role: 'ADMIN', deletedAt: new Date() } });
    const deleted = await mkUser('del', { deletedAt: new Date() });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: deleted.id, role: 'ADMIN' } });
    const chain = (await ownerChain(db, (await rootAlarm()).t.id)).map((p) => p.userId);
    for (const id of [plain.id, platformAdmin.id, gone.id, deleted.id]) expect(chain).not.toContain(id);
  });

  it('a manager who already owns the task appears once, at the owner\'s position', async () => {
    const t = await task({ ownerUserId: orgAdmin.id, assigneeWorkerId: anne.id, assignedAt: at('10:00'), createdAt: at('10:00') });
    const chain = await ownerChain(db, t.id);
    expect(chain[0]).toEqual({ userId: orgAdmin.id }); // the owner, not a manager entry
    expect(chain.filter((p) => p.userId === orgAdmin.id)).toHaveLength(1);
    expect(chain).toHaveLength(3);
  });

  it('a child task\'s chain is its owner, the parent\'s owner, then the managers', async () => {
    const root = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:00') });
    const child = await task({ parentTaskId: root.id, ownerWorkerId: anne.id, assigneeWorkerId: ada.id, assignedAt: at('09:10') });
    const chain = await ownerChain(db, child.id);
    expect(chain.slice(0, 2)).toEqual([{ workerId: anne.id }, { workerId: ada.id }]);
    expect(chain.slice(2).every((p) => p.userId)).toBe(true);
    expect(chain).toHaveLength(2 + 3);
  });

  it('escalation reaches the managers, one window apart, and an acknowledgement stops it', async () => {
    const { a } = await rootAlarm();
    expect((await wakes(a.id)).map((w) => w.dueAt)).toEqual([at('10:15'), at('10:30'), at('10:45'), at('11:00')]);
    await taskStallTick(db, at('10:30'));
    await taskStallTick(db, at('10:45'));
    const rows = await wakes(a.id);
    expect(rows.map((r) => r.wokenAt !== null)).toEqual([true, true, true, false]);
    await M.acknowledgeAlarm({}, { eventId: a.id }, ctx(appOwnerMember.id));
    await taskStallTick(db, at('11:00'));
    expect((await wakes(a.id))[3].wokenAt).toBeNull();
  });

  it('a user-owned App: the owner and its owner-role members, never an org arm', async () => {
    const owner = await mkUser('uo');
    const co = await mkUser('co');
    const userApp = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'U', urn: `am-u-${generateId().toLowerCase()}` } });
    await db.appMember.create({ data: { appId: userApp.id, userId: co.id, role: 'owner' } });
    expect(await appManagerUserIds(db, userApp)).toEqual([owner.id, co.id]);
  });

  it('differential: everyone in the list manages the App by the acknowledgement gate\'s own predicate', async () => {
    for (const userId of await appManagerUserIds(db, app)) {
      expect(await managesApp({ db, userId, roles: ['READER'] }, app)).toBe(true);
    }
    expect(await managesApp({ db, userId: plain.id, roles: ['READER'] }, app)).toBe(false);
  });

  it('mergeUsers refuses an account named in an open alarm as a MANAGER entry, and proceeds once it is acknowledged', async () => {
    await db.user.update({ where: { id: platformAdmin.id }, data: { roles: ['ADMIN'] } });
    const target = await mkUser('tg');
    const { a } = await rootAlarm();
    expect((a.chain as { userId?: string }[]).some((p) => p.userId === orgAdmin.id)).toBe(true);
    for (const [sourceUserId, targetUserId] of [[orgAdmin.id, target.id], [target.id, orgAdmin.id]]) {
      try {
        await mergeUsers(db, { sourceUserId, targetUserId, actorUserId: platformAdmin.id });
        expect.fail('expected the merge to be refused');
      } catch (e) {
        expect((e as GraphQLError).extensions).toEqual({ code: 'MERGE_USER_IN_OPEN_ALARMS', alarmCount: 1 });
      }
    }
    await M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgOwner.id));
    await expect(mergeUsers(db, { sourceUserId: target.id, targetUserId: orgAdmin.id, actorUserId: platformAdmin.id })).resolves.toBeDefined();
  });
});

describe('#1762 — any chain owner, or whoever manages the App, may acknowledge (cor:agt:050:24)', () => {
  /** An alarm whose chain does NOT name the managers: raised before they managed, or by a platform admin. */
  async function alarmWithoutManagers() {
    const t = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('10:00'), createdAt: at('10:00') });
    return db.agentTeamEvent.create({
      data: {
        appId: app.id, taskId: t.id, type: 'stall.not-started', severity: 'alarm', chain: [{ workerId: ada.id }],
        episodeStart: at('10:00'), createdAt: at('10:15'), subjectWorkerId: anne.id,
      } as any,
    });
  }

  it.each([
    ['an org admin', () => orgAdmin],
    ['an org owner', () => orgOwner],
    ['an owner-role App member', () => appOwnerMember],
    ['a platform admin on an org-owned App', () => platformAdmin],
  ])('%s outside the chain acknowledges, recorded as themselves', async (_n, who) => {
    const a = await alarmWithoutManagers();
    const acked = await M.acknowledgeAlarm({}, { eventId: a.id }, ctx(who().id, { roles: who() === platformAdmin ? ['ADMIN'] : ['READER'] }));
    expect(acked).toMatchObject({ id: a.id, acknowledgedByUserId: who().id, acknowledgedByWorkerId: null });
    expect(acked.acknowledgedAt).toBeInstanceOf(Date);
  });

  it('a non-manager outside the chain is still refused, and nothing is written', async () => {
    const a = await alarmWithoutManagers();
    await expectCode(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(plain.id)), 'ALARM_NOT_IN_CHAIN');
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt).toBeNull();
  });

  it('a worker acting through a session is never "the manager", even when its driver manages the App', async () => {
    const a = await alarmWithoutManagers();
    const other = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Liam', slug: 'liam' }, select: { id: true } });
    await expectCode(
      runAsActor({ workerId: other.id, agentId }, () => M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgAdmin.id))),
      'ALARM_NOT_IN_CHAIN',
    );
  });

  it('an impersonating session of a manager is read-only, and a manager of ANOTHER App is refused', async () => {
    const a = await alarmWithoutManagers();
    await expect(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgAdmin.id, { impersonation: { actorUserId: platformAdmin.id } as any }))).rejects.toBeInstanceOf(GraphQLError);
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'o2', urn: `o2-${generateId().toLowerCase()}.example` } });
    const stranger = await mkUser('st');
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: stranger.id, role: 'ADMIN' } });
    await expectCode(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(stranger.id)), 'ALARM_NOT_FOUND');
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt).toBeNull();
  });

  it('the first acknowledgement stands: a second, by a manager, is refused', async () => {
    const a = await alarmWithoutManagers();
    await M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgAdmin.id));
    await expectCode(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgOwner.id)), 'ALARM_ALREADY_ACKNOWLEDGED');
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedByUserId).toBe(orgAdmin.id);
  });

  it('a manager acknowledges an alarm on a CHILD task they own nothing in', async () => {
    const root = await task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at('09:00') });
    const child = await task({ parentTaskId: root.id, ownerWorkerId: anne.id, assigneeWorkerId: ada.id, assignedAt: at('10:00') });
    const a = await db.agentTeamEvent.create({
      data: {
        appId: app.id, taskId: child.id, type: 'stall.not-started', severity: 'alarm', chain: [{ workerId: anne.id }, { workerId: ada.id }],
        episodeStart: at('10:00'), createdAt: at('10:15'), subjectWorkerId: ada.id,
      } as any,
    });
    await expect(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgAdmin.id))).resolves.toMatchObject({ acknowledgedByUserId: orgAdmin.id });
  });
});

describe('set equality: the chain\'s managers are managesApp\'s users minus the platform arm (Xylon P2-1 on #1816)', () => {
  /** Every candidate in `pool` that `managesApp` admits WITHOUT the platform-role arm (callers hold plain roles). */
  const managersByGate = async (a: typeof app, pool: { id: string }[]) => {
    const out: string[] = [];
    for (const u of pool) if (await managesApp({ db, userId: u.id, roles: ['READER'] }, a)) out.push(u.id);
    return out.sort();
  };

  it('org-owned: owner-role members and live org ADMIN/OWNER, nobody else', async () => {
    const gone = await mkUser('gone');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: gone.id, role: 'ADMIN', deletedAt: new Date() } });
    const contributor = await mkUser('co');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
    const pool = [orgAdmin, orgOwner, appOwnerMember, plain, platformAdmin, gone, contributor];
    expect((await appManagerUserIds(db, app)).sort()).toEqual(await managersByGate(app, pool));
  });

  it('user-owned: the owner and owner-role members, never an org arm', async () => {
    const owner = await mkUser('uo');
    const co = await mkUser('uco');
    const member = await mkUser('um');
    const userApp = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'U2', urn: `am-u2-${generateId().toLowerCase()}` } });
    await db.appMember.create({ data: { appId: userApp.id, userId: co.id, role: 'owner' } });
    await db.appMember.create({ data: { appId: userApp.id, userId: member.id, role: 'member' } });
    const pool = [owner, co, member, orgAdmin, orgOwner, platformAdmin];
    expect((await appManagerUserIds(db, userApp)).sort()).toEqual(await managersByGate(userApp, pool));
    // The both-owner shape does not exist: an App is owned by a user XOR an org (chk_app_owner_xor).
    await expect(db.app.create({ data: { id: generateId(), ownerUserId: owner.id, organizationId: org.id, name: 'B', urn: `am-b-${generateId().toLowerCase()}` } })).rejects.toBeDefined();
  });

  it('the one asymmetry is the platform-admin arm: it gates, and is never listed', async () => {
    expect(await managesApp({ db, userId: platformAdmin.id, roles: ['ADMIN'] }, app)).toBe(true);
    expect(await appManagerUserIds(db, app)).not.toContain(platformAdmin.id);
  });
});

describe('provenance: a manager entry is not an owner (Diego P2 on #1816)', () => {
  it('a manager demoted after the alarm was raised can no longer acknowledge it, while a true owner and a current manager can', async () => {
    const { a } = await rootAlarm();
    // Demote the org admin to a plain org member; they stay an App participant.
    await db.orgMember.updateMany({ where: { userId: orgAdmin.id }, data: { role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: app.id, userId: orgAdmin.id, role: 'member' } });
    expect((a.chain as { userId?: string }[]).some((p) => p.userId === orgAdmin.id)).toBe(true);
    await expectCode(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgAdmin.id)), 'ALARM_NOT_IN_CHAIN');
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt).toBeNull();
    // A current manager still acknowledges.
    await expect(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgOwner.id))).resolves.toMatchObject({ acknowledgedByUserId: orgOwner.id });
  });

  it('a person who OWNS the task and is later demoted keeps the owner\'s standing; the same person as a manager entry does not', async () => {
    const t = await task({ ownerUserId: orgAdmin.id, assigneeWorkerId: anne.id, assignedAt: at('10:00'), createdAt: at('10:00') });
    await taskStallTick(db, at('10:15'));
    const [a] = await alarmsList();
    expect(a.taskId).toBe(t.id);
    expect((a.chain as unknown[])[0]).toEqual({ userId: orgAdmin.id });
    await db.orgMember.updateMany({ where: { userId: orgAdmin.id }, data: { role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: app.id, userId: orgAdmin.id, role: 'member' } });
    await expect(M.acknowledgeAlarm({}, { eventId: a.id }, ctx(orgAdmin.id))).resolves.toMatchObject({ acknowledgedByUserId: orgAdmin.id });
  });

  it('a chain entry\'s provenance still blocks a merge (containment on userId)', async () => {
    const { a } = await rootAlarm();
    const [{ count }] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM agent_team_events WHERE id = ${a.id} AND chain @> ${JSON.stringify([{ userId: orgAdmin.id }])}::jsonb`;
    expect(count).toBe(1);
  });
});
