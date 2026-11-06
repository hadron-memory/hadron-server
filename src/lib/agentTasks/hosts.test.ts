import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1707 — host registrations (cor:agt:070:01): the internal writer, what makes
 * a worker launchable, and the lapse after the App's count of poll intervals (default 3, #1763)
 * (`host.lost`, once). The public mutation (#1709) takes the host's identity
 * from its `host:operate` key, never from a request: resolvers.hostOperation.test.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { __lostHostTesting, HostRegistrationError, isRegistrationLive, loadLaunchableFamilies, registerHost, sweepLostHosts, type HostRegistrationInput } from './hosts.js';

const DAY = '2026-10-09';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}Z`);

let app: { id: string };
let other: { id: string };
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };
let stranger: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: { id: generateId(), roles: ['READER'] }, select: { id: true } });
  const mkApp = (name: string) =>
    db.app.create({ data: { id: generateId(), name, urn: `hosts-${generateId().toLowerCase()}:team`, ownerUserId: owner.id }, select: { id: true } });
  app = await mkApp('Team');
  other = await mkApp('Other');
  const agent = await db.agent.create({ data: { id: generateId(), name: 'A', urn: `hosts-agent-${generateId().toLowerCase()}`, ownerUserId: owner.id }, select: { id: true } });
  const worker = (appId: string, name: string) =>
    // #1709: held, so a host can launch them (cor:agt:060:05).
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: owner.id }, select: { id: true } });
  anne = await worker(app.id, 'Anne');
  liam = await worker(app.id, 'Liam');
  rook = await worker(app.id, 'Rook');
  stranger = await worker(other.id, 'Stranger');
});

const ORCA1 = () => ({
  appId: app.id, hostId: 'orca1', label: 'Orca host 1', pollIntervalSeconds: 60,
  workers: [{ workerId: anne.id, family: 'codex', worktrees: ['repo/anne'] }, { workerId: liam.id, family: 'glm', worktrees: ['repo/liam'] }, { workerId: rook.id, family: 'claude', worktrees: ['repo/rook'] }],
});
const hostEvents = () => db.agentTeamEvent.findMany({ where: { type: { startsWith: 'host.' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

describe('cor:agt:070:01 — a host registers which workers it can launch, and as which family', () => {
  it('#2191 normalizes registration storage and existing aliases on launchable comparison', async () => {
    const r = await registerHost(db, { ...ORCA1(), workers: [{ workerId: anne.id, family: ' OpenAI ', worktrees: ['repo/anne'] }] }, at('10:00'));
    expect((await db.hostRegistrationWorker.findFirstOrThrow({ where: { registrationId: r.registrationId } })).family).toBe('codex');
    await db.hostRegistrationWorker.updateMany({ where: { registrationId: r.registrationId }, data: { family: 'openai' } });
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:01'))).get(anne.id)).toEqual(['codex']);
  });

  it('the spec example: orca1 registers anne as codex, liam as glm, rook as claude', async () => {
    const r = await registerHost(db, ORCA1(), at('10:00'));
    expect(r.registered).toBe(true);
    const launchable = await loadLaunchableFamilies(db, { appId: app.id }, at('10:01'));
    expect(Object.fromEntries(launchable)).toEqual({ [anne.id]: ['codex'], [liam.id]: ['glm'], [rook.id]: ['claude'] });
    const [ev] = await hostEvents();
    // Ids, a token and a count — never the label, which is free text.
    expect(ev).toMatchObject({ type: 'host.registered', payload: { registrationId: r.registrationId, hostId: 'orca1', workerCount: 3 } });
    expect(JSON.stringify(ev.payload)).not.toContain('Orca host 1');
  });

  it('a refresh replaces the worker list and writes no event; identity is (App, host)', async () => {
    const first = await registerHost(db, ORCA1(), at('10:00'));
    const again = await registerHost(db, { ...ORCA1(), label: 'renamed', workers: [{ workerId: anne.id, family: 'claude', worktrees: ['repo/anne'] }] }, at('10:01'));
    expect(again).toEqual({ registrationId: first.registrationId, registered: false });
    expect(Object.fromEntries(await loadLaunchableFamilies(db, { appId: app.id }, at('10:02')))).toEqual({ [anne.id]: ['claude'] });
    expect(await hostEvents()).toHaveLength(1);
    expect(await db.hostRegistration.count()).toBe(1);
  });

  it('a worker may be launchable through several hosts, as different families', async () => {
    await registerHost(db, ORCA1(), at('10:00'));
    await registerHost(db, { ...ORCA1(), hostId: 'orca2', label: 'orca2', workers: [{ workerId: anne.id, family: 'glm', worktrees: ['repo/anne'] }] }, at('10:00'));
    expect((await loadLaunchableFamilies(db, { workerIds: [anne.id] }, at('10:01'))).get(anne.id)).toEqual(['codex', 'glm']);
  });

  it('refuses a worker of another App, a retired worker, a bad family, or a worker listed twice — writing nothing', async () => {
    const refused = async (input: HostRegistrationInput) => {
      await expect(registerHost(db, input, at('10:00'))).rejects.toBeInstanceOf(HostRegistrationError);
    };
    await refused({ ...ORCA1(), workers: [{ workerId: stranger.id, family: 'codex' }] });
    await db.worker.update({ where: { id: liam.id }, data: { retiredAt: at('09:00') } });
    await refused({ ...ORCA1(), workers: [{ workerId: liam.id, family: 'glm', worktrees: ['repo/liam'] }] });
    await refused({ ...ORCA1(), workers: [{ workerId: anne.id, family: 'not a family' }] });
    await refused({ ...ORCA1(), workers: [{ workerId: anne.id, family: 'codex', worktrees: ['repo/anne'] }, { workerId: anne.id, family: 'glm', worktrees: ['repo/anne'] }] });
    await refused({ ...ORCA1(), hostId: 'has space' });
    await refused({ ...ORCA1(), label: '' });
    await refused({ ...ORCA1(), pollIntervalSeconds: 0 });
    expect(await db.hostRegistration.count()).toBe(0);
    expect(await hostEvents()).toEqual([]);
  });

  it('refuses an uninstalled App', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('09:00') } });
    await expect(registerHost(db, ORCA1(), at('10:00'))).rejects.toMatchObject({ code: 'APP_NOT_LIVE' });
  });

  it('#1709: the public registerHost takes no host id: the host identity comes from the key, never a request', () => {
    const input = /input RegisterHostInput \{([^}]*)\}/.exec(typeDefs)?.[1] ?? '';
    expect(input).toMatch(/appRef/);
    expect(input).not.toMatch(/hostId/);
    expect(typeDefs).toMatch(/registerHost\(input: RegisterHostInput!\): HostRegistration!/);
  });
});

describe('lapse (cor:agt:070:01 open question: 3 poll intervals)', () => {
  it('live through 3 intervals inclusive; lapsed after, and its workers stop counting', async () => {
    await registerHost(db, ORCA1(), at('10:00'));
    expect(isRegistrationLive({ refreshedAt: at('10:00'), pollIntervalSeconds: 60 }, at('10:03'))).toBe(true);
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:03'))).size).toBe(3);
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:03:00.001'))).size).toBe(0);
  });

  it('the sweep writes host.lost once; a refresh brings it back with host.registered', async () => {
    const { registrationId } = await registerHost(db, ORCA1(), at('10:00'));
    expect(await sweepLostHosts(db, at('10:02'))).toBe(0);
    expect(await sweepLostHosts(db, at('10:04'))).toBe(1);
    expect(await sweepLostHosts(db, at('10:05'))).toBe(0);
    expect((await db.hostRegistration.findUniqueOrThrow({ where: { id: registrationId } })).lostAt).toEqual(at('10:04'));
    const back = await registerHost(db, ORCA1(), at('10:06'));
    expect(back.registered).toBe(true);
    expect((await db.hostRegistration.findUniqueOrThrow({ where: { id: registrationId } })).lostAt).toBeNull();
    expect((await hostEvents()).map((e) => [e.type, e.createdAt])).toEqual([
      ['host.registered', at('10:00')], ['host.lost', at('10:04')], ['host.registered', at('10:06')],
    ]);
  });

  it('a refresh after a lapse the sweep never saw still writes host.registered', async () => {
    await registerHost(db, ORCA1(), at('10:00'));
    expect((await registerHost(db, ORCA1(), at('10:10'))).registered).toBe(true);
  });

  it('#1763: an App that sets 5 check-ins keeps a registration live through 4 missed ones', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, hostLapseCheckIns: 5 } });
    const { registrationId } = await registerHost(db, ORCA1(), at('10:00'));
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:04'))).size).toBe(3);
    expect((await loadLaunchableFamilies(db, { workerIds: [anne.id] }, at('10:05'))).get(anne.id)).toEqual(['codex']);
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:05:00.001'))).size).toBe(0);
    expect(await sweepLostHosts(db, at('10:05'))).toBe(0);
    // A refresh inside the App's window is ordinary, not a re-registration.
    expect((await registerHost(db, ORCA1(), at('10:04'))).registered).toBe(false);
    expect(await sweepLostHosts(db, at('10:09:00.001'))).toBe(1);
    expect((await db.hostRegistration.findUniqueOrThrow({ where: { id: registrationId } })).lostAt).toEqual(at('10:09:00.001'));
  });

  it('#1763: the setting is the App\'s own; another App keeps the default of 3, and 2 shortens it', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, hostLapseCheckIns: 2 } });
    await registerHost(db, ORCA1(), at('10:00'));
    await registerHost(db, { appId: other.id, hostId: 'orca1', label: 'Other', pollIntervalSeconds: 60, workers: [{ workerId: stranger.id, family: 'claude', worktrees: ['repo/stranger'] }] }, at('10:00'));
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:02:00.001'))).size).toBe(0);
    expect((await loadLaunchableFamilies(db, { appId: other.id }, at('10:03'))).size).toBe(1);
    expect(await sweepLostHosts(db, at('10:02:30'))).toBe(1);
    expect((await registerHost(db, ORCA1(), at('10:02:40'))).registered).toBe(true);
  });

  it('#1763 (Anne P2): a count raised after the sweep\'s read is honoured at its write; the host stays live', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, hostLapseCheckIns: 2 } });
    const { registrationId } = await registerHost(db, ORCA1(), at('10:00'));
    const [candidate] = await __lostHostTesting.readLostCandidates(db, at('10:02:30'));
    expect(candidate).toMatchObject({ id: registrationId });
    // The manager raises the count to 5 between the read and the write.
    await db.agentTaskStallSchedule.update({ where: { appId: app.id }, data: { hostLapseCheckIns: 5 } });
    expect(await __lostHostTesting.recordHostLost(db, candidate, at('10:02:30'))).toBe(false);
    expect((await db.hostRegistration.findUniqueOrThrow({ where: { id: registrationId } })).lostAt).toBeNull();
    expect((await hostEvents()).map((e) => e.type)).toEqual(['host.registered']);
    // Controls: an unchanged count, and a refresh after the read.
    await db.agentTaskStallSchedule.update({ where: { appId: app.id }, data: { hostLapseCheckIns: 2 } });
    const [again] = await __lostHostTesting.readLostCandidates(db, at('10:02:30'));
    await registerHost(db, ORCA1(), at('10:01:50'));
    expect(await __lostHostTesting.recordHostLost(db, again, at('10:02:30'))).toBe(false);
    const [later] = await __lostHostTesting.readLostCandidates(db, at('10:05'));
    expect(await __lostHostTesting.recordHostLost(db, later, at('10:05'))).toBe(true);
    // A second pass holding the same candidate records nothing more.
    expect(await __lostHostTesting.recordHostLost(db, later, at('10:06'))).toBe(false);
    expect((await hostEvents()).map((e) => e.type)).toEqual(['host.registered', 'host.lost']);
  });

  it('#1763 (Anne P2): the write waits for an in-flight count change and then honours it (FOR SHARE)', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, hostLapseCheckIns: 2 } });
    const { registrationId } = await registerHost(db, ORCA1(), at('10:00'));
    const [candidate] = await __lostHostTesting.readLostCandidates(db, at('10:02:30'));
    // A manager's change, row-locked and not yet committed, on its own connection.
    const manager = new Client({ connectionString: process.env.DATABASE_URL });
    await manager.connect();
    try {
      await manager.query('BEGIN');
      await manager.query('UPDATE agent_task_stall_schedule SET host_lapse_check_ins = 5 WHERE app_id = $1', [app.id]);
      let settled = false;
      const write = __lostHostTesting.recordHostLost(db, candidate, at('10:02:30')).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await manager.query('COMMIT');
      expect(await write).toBe(false);
    } finally {
      await manager.end();
    }
    expect((await db.hostRegistration.findUniqueOrThrow({ where: { id: registrationId } })).lostAt).toBeNull();
  });

  it('#1763 (Anne P2, round 2): with NO schedule row yet, the write waits for the App\'s first setting and honours it', async () => {
    const { registrationId } = await registerHost(db, ORCA1(), at('10:00'));
    const [candidate] = await __lostHostTesting.readLostCandidates(db, at('10:03:30'));
    expect(candidate).toMatchObject({ id: registrationId });
    expect(await db.agentTaskStallSchedule.count()).toBe(0);
    // The App's FIRST setting (5), in flight on its own connection, under the setter's lock protocol.
    const manager = new Client({ connectionString: process.env.DATABASE_URL });
    await manager.connect();
    try {
      await manager.query('BEGIN');
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('host-lapse:' || $1))", [app.id]);
      await manager.query('INSERT INTO agent_task_stall_schedule (app_id, host_lapse_check_ins, updated_at) VALUES ($1, 5, now())', [app.id]);
      let settled = false;
      const write = __lostHostTesting.recordHostLost(db, candidate, at('10:03:30')).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await manager.query('COMMIT');
      expect(await write).toBe(false);
    } finally {
      await manager.end();
    }
    expect((await db.hostRegistration.findUniqueOrThrow({ where: { id: registrationId } })).lostAt).toBeNull();
  });

  it('#1763: an App\'s schedule row with no lapse set keeps the default of 3', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, noProgressMinutes: 90 } });
    await registerHost(db, ORCA1(), at('10:00'));
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:03'))).size).toBe(3);
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:03:00.001'))).size).toBe(0);
  });

  it('an uninstalled App\'s registrations launch nothing', async () => {
    await registerHost(db, ORCA1(), at('10:00'));
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('10:01') } });
    expect((await loadLaunchableFamilies(db, { appId: app.id }, at('10:01'))).size).toBe(0);
  });
});
