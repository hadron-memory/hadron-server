/**
 * #4375 — the ONE definition of a lead (cor:agt:020:12): a worker that at least one worker reports to, neither retired.
 * The cadence alarm (#4375), the report-based cadence rule (#4937) and #4921 slice B all import it, so this file is the
 * contract they rely on. No role takes part.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { computeLeadIds, isLeadWorker, leadWorkerIds, type LeadRosterRow } from './leads.js';

const row = (id: string, reportsToWorkerId: string | null, retired = false): LeadRosterRow => ({ id, reportsToWorkerId, retiredAt: retired ? new Date('2026-11-01T00:00:00Z') : null });
const ids = (s: Set<string>) => [...s].sort();

describe('#4375 computeLeadIds: the rule itself', () => {
  it('a worker somebody reports to is a lead; a worker nobody reports to is not', () => {
    expect(ids(computeLeadIds([row('a', null), row('b', 'a'), row('c', 'a'), row('d', null)]))).toEqual(['a']);
  });

  it('a sub-lead (reports to a lead and has reports of its own) is a lead too', () => {
    expect(ids(computeLeadIds([row('a', null), row('b', 'a'), row('c', 'b')]))).toEqual(['a', 'b']);
  });

  it('a roster with nobody reporting to anybody has no lead', () => {
    expect(computeLeadIds([row('a', null), row('b', null)]).size).toBe(0);
    expect(computeLeadIds([]).size).toBe(0);
  });

  it('a retired reporter does not make its lead a lead', () => {
    expect(computeLeadIds([row('a', null), row('b', 'a', true)]).size).toBe(0);
    expect(ids(computeLeadIds([row('a', null), row('b', 'a', true), row('c', 'a')]))).toEqual(['a']);
  });

  it('a retired worker is not a lead, whoever reports to it', () => {
    expect(computeLeadIds([row('a', null, true), row('b', 'a')]).size).toBe(0);
  });

  it('a worker reporting to itself does not make itself a lead', () => {
    expect(computeLeadIds([row('a', 'a')]).size).toBe(0);
  });

  it('a reporting line to a worker outside the roster makes nobody a lead', () => {
    expect(computeLeadIds([row('a', 'ghost')]).size).toBe(0);
  });

  it('takes no role: the rows carry none', () => {
    expect(Object.keys(row('a', null)).sort()).toEqual(['id', 'reportsToWorkerId', 'retiredAt']);
  });
});

describe('#4375 leadWorkerIds / isLeadWorker: the same rule over an App\'s roster', () => {
  let appId: string;
  let otherAppId: string;
  let agentId: string;
  let userId: string;
  const mk = (app: string, name: string, reportsTo: string | null, role = 'engineer', retired = false) =>
    db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app, agentId, name, slug: `${name.toLowerCase()}-${generateId().slice(-6)}`, role, heldByUserId: userId, reportsToWorkerId: reportsTo, retiredAt: retired ? new Date() : null },
      select: { id: true },
    });

  beforeEach(async () => {
    await cleanDb(db);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const org = await db.organization.create({ data: { id: generateId(), name: 'lead-org', urn: `lead-${suffix}.com` } });
    userId = (await db.user.create({ data: { id: generateId(), githubId: 98_400 + Math.floor(Math.random() * 1000), githubUsername: `lead-${suffix}`, roles: ['READER'] } })).id;
    agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } })).id;
    appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } })).id;
    otherAppId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } })).id;
    await db.appAgent.create({ data: { appId, agentId } });
    await db.appAgent.create({ data: { appId: otherAppId, agentId } });
  });

  it('reads the App\'s roster through the given client and applies the rule', async () => {
    const lead = await mk(appId, 'Lead', null, 'whatever');
    const sub = await mk(appId, 'Sub', lead.id);
    await mk(appId, 'Plain', sub.id);
    const alone = await mk(appId, 'Alone', null, 'coordinator');
    expect(ids(await leadWorkerIds(db, appId))).toEqual([lead.id, sub.id].sort());
    expect(await isLeadWorker(db, appId, lead.id)).toBe(true);
    expect(await isLeadWorker(db, appId, sub.id)).toBe(true);
    expect(await isLeadWorker(db, appId, alone.id)).toBe(false); // the coordinator role makes nobody a lead
  });

  it('ignores retired workers on either side of the line, and another App\'s workers', async () => {
    const lead = await mk(appId, 'Lead', null);
    await mk(appId, 'Gone', lead.id, 'engineer', true);
    expect((await leadWorkerIds(db, appId)).size).toBe(0);
    const foreign = await mk(otherAppId, 'Foreign', null);
    await mk(otherAppId, 'Report', foreign.id);
    expect((await leadWorkerIds(db, appId)).size).toBe(0);
    expect(await isLeadWorker(db, appId, foreign.id)).toBe(false); // a lead of another App is not this App's
    expect(await isLeadWorker(db, otherAppId, foreign.id)).toBe(true);
  });

  it('follows a change at once: a worker becomes a lead when somebody starts reporting to it, and stops when they leave', async () => {
    const a = await mk(appId, 'A', null);
    const b = await mk(appId, 'B', null);
    expect(await isLeadWorker(db, appId, a.id)).toBe(false);
    await db.worker.update({ where: { id: b.id }, data: { reportsToWorkerId: a.id } });
    expect(await isLeadWorker(db, appId, a.id)).toBe(true);
    await db.worker.update({ where: { id: b.id }, data: { reportsToWorkerId: null } });
    expect(await isLeadWorker(db, appId, a.id)).toBe(false);
  });
});
