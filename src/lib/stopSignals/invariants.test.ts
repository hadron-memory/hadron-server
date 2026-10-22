import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2022 — prisma/stop-signal-invariants.sql is the single source for the stop-signal facts Prisma cannot model; the
 * migration carries a byte-identical copy and post-push.sql includes the file. Here, the facts no resolver path reaches:
 * the shape, the same-App target, the write-once end, the one open interval and the one open hold.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

describe('stop-signal-invariants.sql (#2022)', () => {
  it('the migration carries a byte-identical copy, and post-push includes the file', () => {
    const source = readFileSync(new URL('../../../prisma/stop-signal-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261020030000_stop_signals/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir stop-signal-invariants.sql');
  });

  describe('constraints', () => {
    let appId: string;
    let otherAppId: string;
    let workerId: string;
    let foreignWorkerId: string;
    let userId: string;
    beforeEach(async () => {
      await cleanDb(db);
      const n = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
      const org = await db.organization.create({ data: { id: generateId(), name: 'si', urn: `si-${n}.com` } });
      userId = (await db.user.create({ data: { id: generateId(), githubId: 96_000 + Math.floor(Math.random() * 1e6), githubUsername: `si-${n}`, roles: ['READER'] } })).id;
      const agent = await db.agent.create({ data: { id: generateId(), name: 'A', organizationId: org.id, urn: `${org.urn}:a` } as never });
      appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t` } })).id;
      otherAppId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'O', urn: `${org.urn}:o` } })).id;
      workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'W', slug: 'w' } })).id;
      foreignWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: otherAppId, agentId: agent.id, name: 'Z', slug: 'z' } })).id;
    });
    const bad = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);
    const base = () => ({ id: generateId(), appId, level: 'pause', scope: 'worker', targetWorkerId: workerId, setAt: new Date(), setByUserId: userId });

    it('a closed level and scope, one target of the scope\'s kind, exactly one setter, an until after the set', async () => {
      await bad(db.teamStopSignal.create({ data: { ...base(), level: 'stop' } }), /chk_team_stop_signals_shape/);
      await bad(db.teamStopSignal.create({ data: { ...base(), scope: 'org' } }), /chk_team_stop_signals_shape/);
      await bad(db.teamStopSignal.create({ data: { ...base(), scope: 'host' } }), /chk_team_stop_signals_shape/);
      await bad(db.teamStopSignal.create({ data: { ...base(), setByUserId: null } }), /chk_team_stop_signals_shape/);
      await bad(db.teamStopSignal.create({ data: { ...base(), setByAppKeyId: 'k' } }), /chk_team_stop_signals_shape/);
      const now = new Date();
      await bad(db.teamStopSignal.create({ data: { ...base(), setAt: now, until: now } }), /chk_team_stop_signals_shape/);
      await expect(db.teamStopSignal.create({ data: base() })).resolves.toBeTruthy();
    });

    it('the target belongs to the signal\'s App', async () => {
      await bad(db.teamStopSignal.create({ data: { ...base(), targetWorkerId: foreignWorkerId } }), /is not in the signal's App/);
    });

    it('an end is complete and recorded once; nothing else changes', async () => {
      const s = await db.teamStopSignal.create({ data: base() });
      await bad(db.teamStopSignal.update({ where: { id: s.id }, data: { endedAt: new Date(), endKind: 'lifted' } }), /chk_team_stop_signals_shape/);
      await bad(db.teamStopSignal.update({ where: { id: s.id }, data: { level: 'halt' } }), /only a live signal's end may be recorded, once/);
      await db.teamStopSignal.update({ where: { id: s.id }, data: { endedAt: new Date(), endKind: 'lifted', endedByUserId: userId } });
      await bad(db.teamStopSignal.update({ where: { id: s.id }, data: { endedByUserId: 'someone-else' } }), /only a live signal's end may be recorded, once/);
      // An expiry ends exactly at its until, and names nobody.
      const until = new Date(Date.now() + 60_000);
      const e = await db.teamStopSignal.create({ data: { ...base(), until } });
      await bad(db.teamStopSignal.update({ where: { id: e.id }, data: { endedAt: new Date(), endKind: 'expired' } }), /chk_team_stop_signals_shape/);
      await expect(db.teamStopSignal.update({ where: { id: e.id }, data: { endedAt: until, endKind: 'expired' } })).resolves.toBeTruthy();
    });

    it('one open coverage interval per (signal, worker); one open stop hold per task', async () => {
      const s = await db.teamStopSignal.create({ data: base() });
      const iv = () => db.teamStopCoverage.create({ data: { id: generateId(), appId, signalId: s.id, workerId, enteredAt: new Date() } });
      await iv();
      await bad(iv(), /Unique constraint|team_stop_coverage_open_uniq/);
      const task = await db.agentTask.create({ data: { appId, title: 't', ownerUserId: userId } });
      const hold = () => db.agentTaskStopHold.create({ data: { id: generateId(), appId, taskId: task.id, startedAt: new Date() } });
      await hold();
      await bad(hold(), /Unique constraint|agent_task_stop_holds_open_uniq/);
    });
  });
});
