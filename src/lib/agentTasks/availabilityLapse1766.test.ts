import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1766 — an availability mark that expires records the lapse
 * (cor:agt:060:02: once `until` passes the worker reads as available, and
 * EXACTLY ONE availability-changed event records the lapse).
 *
 * The matcher's 1-minute sweep (`taskMatcherTick`) writes the lapse down
 * before it matches, so a queued task goes to the lapsed worker in the same
 * pass. Driven with an injected `now`; the event-driven runs are not involved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';
import { __lapseTesting, recordLapsedAvailability } from './availability.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
// In the past, so a manual set at the real now (one scenario) comes after the injected clock.
const DAY = '2026-10-09';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00Z`);

let app: { id: string };
let agentId: string;
let mia: { id: string };
let baloo: { id: string };
let rook: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Lapse', urn: `lapse-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 610_000 + n, githubUsername: `lp-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 710_000 + n, githubUsername: `lp-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx)).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `lapse-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'reviewer', heldByUserId: mia.id }, select: { id: true } });
  baloo = await worker('Baloo');
  rook = await worker('Rook');
});

/** Mia (the holder) marked `w` out of tokens at 10:00, until `until` (or with no end). */
function outOfTokens(w: { id: string }, until: Date | null) {
  return db.workerAvailability.create({
    data: { workerId: w.id, state: 'unavailable', reason: 'out-of-tokens', until, setAt: at('10:00'), setBy: 'holder', setByUserId: mia.id },
  });
}

const availabilityEvents = (w: { id: string }) =>
  db.agentTeamEvent.findMany({ where: { type: 'availability.changed', subjectWorkerId: w.id }, orderBy: { createdAt: 'asc' } });

describe('cor:agt:060:02 — a passed until is recorded, exactly once', () => {
  it('a record whose until has passed: the sweep writes one availability.changed event and the record reads available', async () => {
    await outOfTokens(baloo, at('18:00'));
    const result = await taskMatcherTick(db, at('18:01'));
    expect(result.lapsed).toBe(1);

    const events = await availabilityEvents(baloo);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      appId: app.id, actorUserId: null, actorWorkerId: null, actorAgentId: null, severity: null, taskId: null,
      payload: { state: 'available', reason: null, until: null, setBy: 'lapse', lapsedAt: at('18:00').toISOString() },
      createdAt: at('18:01'),
    });

    // The row is rewritten: available since the instant it lapsed, set by the lapse, no person or worker behind it.
    expect(await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } })).toMatchObject({
      state: 'available', reason: null, until: null, setAt: at('18:00'), setBy: 'lapse',
      setByUserId: null, setByWorkerId: null, setByAgentId: null,
    });
  });

  it('a second pass writes nothing more', async () => {
    await outOfTokens(baloo, at('18:00'));
    await taskMatcherTick(db, at('18:01'));
    expect((await taskMatcherTick(db, at('18:02'))).lapsed).toBe(0);
    expect(await availabilityEvents(baloo)).toHaveLength(1);
  });

  it('overlapping passes (a second instance) write exactly one event', async () => {
    await outOfTokens(baloo, at('18:00'));
    await outOfTokens(rook, at('17:30'));
    const counts = await Promise.all(Array.from({ length: 6 }, () => recordLapsedAvailability(db, at('18:01'))));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(await availabilityEvents(baloo)).toHaveLength(1);
    expect(await availabilityEvents(rook)).toHaveLength(1);
  });

  it('with a read barrier: six passes ALL read both records before any writes, and exactly one write lands per record (#1851 review, Colin P3)', async () => {
    await outOfTokens(baloo, at('18:00'));
    await outOfTokens(rook, at('17:30'));
    const { readLapsed, recordLapse } = __lapseTesting;
    // Every pass has read both candidates before any pass writes: the guarded update alone decides.
    const reads = await Promise.all(Array.from({ length: 6 }, () => readLapsed(db, at('18:01'), null)));
    for (const page of reads) expect(page.map((r) => r.workerId).sort()).toEqual([baloo.id, rook.id].sort());
    const wins = await Promise.all(reads.flatMap((page) => page.map((r) => recordLapse(db, r, at('18:01')).then((ok) => (ok ? r.workerId : null)))));
    expect(wins.filter((w) => w === baloo.id)).toHaveLength(1);
    expect(wins.filter((w) => w === rook.id)).toHaveLength(1);
    expect(await availabilityEvents(baloo)).toHaveLength(1);
    expect(await availabilityEvents(rook)).toHaveLength(1);
  });

  it('an until still in the future does not lapse; it does once it passes', async () => {
    await outOfTokens(baloo, at('18:00'));
    expect((await taskMatcherTick(db, at('17:59'))).lapsed).toBe(0);
    expect(await availabilityEvents(baloo)).toHaveLength(0);
    expect((await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } })).state).toBe('unavailable');
    // Exactly at until it reads as available (recordInEffect: until <= now), so it is recorded then.
    expect((await taskMatcherTick(db, at('18:00'))).lapsed).toBe(1);
  });

  it('a record with no until never lapses', async () => {
    await outOfTokens(baloo, null);
    expect((await taskMatcherTick(db, at('23:59'))).lapsed).toBe(0);
    expect(await availabilityEvents(baloo)).toHaveLength(0);
  });

  it('a stall mark (cor:agt:060:07) never lapses: it carries no until', async () => {
    await db.workerAvailability.create({
      data: { workerId: baloo.id, state: 'unavailable', reason: 'stalled', setAt: at('10:30'), setBy: 'stall-rule' },
    });
    expect((await taskMatcherTick(db, at('23:59'))).lapsed).toBe(0);
    expect(await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } })).toMatchObject({
      state: 'unavailable', reason: 'stalled', setBy: 'stall-rule',
    });
  });

  it('an available record is left alone', async () => {
    await db.workerAvailability.create({
      data: { workerId: baloo.id, state: 'available', setAt: at('10:00'), setBy: 'holder', setByUserId: mia.id },
    });
    expect((await taskMatcherTick(db, at('23:59'))).lapsed).toBe(0);
    expect(await availabilityEvents(baloo)).toHaveLength(0);
  });

  it('a record re-marked before the sweep reads it is not a candidate', async () => {
    await outOfTokens(baloo, at('18:00'));
    await db.workerAvailability.update({ where: { workerId: baloo.id }, data: { until: at('20:00'), setAt: at('17:59') } });
    expect((await taskMatcherTick(db, at('18:01'))).lapsed).toBe(0);
    expect((await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } })).state).toBe('unavailable');
  });

  // #1851 review (Colin P2): the re-mark lands AFTER the sweep read the record and BEFORE its write, so the
  // guarded update itself must refuse. One case per guard column: dropping `setAt` or `until` from the guard
  // turns the matching case red.
  describe('a record re-marked after the sweep read it is not overwritten (the guarded update)', () => {
    const { readLapsed, recordLapse } = __lapseTesting;

    async function remarkAfterRead(change: { until?: Date; setAt?: Date }) {
      await outOfTokens(baloo, at('18:00'));
      const [read] = await readLapsed(db, at('18:01'), null);
      expect(read).toMatchObject({ workerId: baloo.id, until: at('18:00'), setAt: at('10:00') });
      await db.workerAvailability.update({ where: { workerId: baloo.id }, data: change });
      const before = await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } });
      expect(await recordLapse(db, read, at('18:01'))).toBe(false);
      expect(await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } })).toEqual(before);
      expect(await availabilityEvents(baloo)).toHaveLength(0);
    }

    it('a new until and a new setAt (the holder re-marks it until 20:00)', () => remarkAfterRead({ until: at('20:00'), setAt: at('18:00') }));
    it('a new setAt, same until (pins the setAt guard)', () => remarkAfterRead({ setAt: at('18:00') }));
    it('a new until, same setAt (pins the until guard)', () => remarkAfterRead({ until: at('20:00') }));

    it('control: unchanged after the read, the same write lands', async () => {
      await outOfTokens(baloo, at('18:00'));
      const [read] = await readLapsed(db, at('18:01'), null);
      expect(await recordLapse(db, read, at('18:01'))).toBe(true);
      expect(await availabilityEvents(baloo)).toHaveLength(1);
    });
  });

  it('a later manual set after a recorded lapse is unchanged: its own event, its own setter', async () => {
    await outOfTokens(baloo, at('18:00'));
    await taskMatcherTick(db, at('18:01'));
    const ctx: Context = { db, userId: mia.id, roles: ['READER'] };
    await M.setWorkerAvailability({}, { input: { worker: baloo.id, appRef: app.id, state: 'UNAVAILABLE', reason: 'OTHER' } }, ctx);
    const row = await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } });
    expect(row).toMatchObject({ state: 'unavailable', reason: 'other', until: null, setBy: 'holder', setByUserId: mia.id });
    const events = await availabilityEvents(baloo);
    expect(events.map((e) => (e.payload as { setBy: string }).setBy)).toEqual(['lapse', 'holder']);
  });

  it('GraphQL reads the setter as LAPSE, with no party behind it', async () => {
    await outOfTokens(baloo, at('18:00'));
    await taskMatcherTick(db, at('18:01'));
    const row = await db.workerAvailability.findUniqueOrThrow({ where: { workerId: baloo.id } });
    const R = (resolvers as any).WorkerAvailability;
    const ctx: Context = { db, userId: mia.id, roles: ['READER'] };
    expect(R.setBy(row)).toBe('LAPSE');
    expect(await R.setByParty(row, {}, ctx)).toBeNull();
  });
});

describe('the lapse feeds matching in the same pass (cor:agt:060:06)', () => {
  it('a queued task matches the lapsed worker in the pass that records the lapse, after the lapse event', async () => {
    await db.session.create({
      data: { id: generateId(), appId: app.id, workerId: baloo.id, agentId, family: 'codex', startedAt: at('18:00'), updatedAt: at('18:00') },
    });
    await outOfTokens(baloo, at('18:00'));
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'Review', ownerUserId: mia.id, createdAt: at('11:00') }, select: { id: true } });
    expect(await taskMatcherTick(db, at('18:01'))).toEqual({ lost: 0, lapsed: 1, expired: 0, matched: 1 });
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).assigneeWorkerId).toBe(baloo.id);
  });
});
