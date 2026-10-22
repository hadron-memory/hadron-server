import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2162 (cor:agt:050:27) — the database facts of a context reset (prisma/context-reset-invariants.sql), tested at the
 * database rather than through a resolver: the closed phases and reasons (pinned to types.ts), the stamps each phase
 * implies, the same-App worker, forward-only phases, a kept record, the capability CHECK, and the `resetting` mark's
 * writer (prisma/agent-task-stall-invariants.sql).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { CONTEXT_RESET_FAILURES, CONTEXT_RESET_PHASES, CONTEXT_RESET_REFUSALS } from './types.js';
import { HOST_CAPABILITIES } from '../hostOperations/types.js';

const SOURCE = readFileSync(new URL('../../../prisma/context-reset-invariants.sql', import.meta.url), 'utf8');

let app: { id: string };
let kit: { id: string };
let zed: { id: string };
let session: { id: string };
let task: { id: string };

const check = /23514|check constraint|check_violation|chk_context_resets/;

const row = (data: Record<string, unknown> = {}) =>
  db.contextReset.create({
    data: {
      id: generateId(), appId: app.id, workerId: kit.id, sessionId: session.id, taskId: task.id,
      hostId: null, hostOperationId: null, phase: 'failed', reason: 'HOST_UNSUPPORTED', requestedAt: new Date(), endedAt: new Date(),
      ...data,
    } as any,
  });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Inv', urn: `crinv-${n}.example` } });
  const user = await db.user.create({ data: { githubId: 83_000_000 + n, githubUsername: `ci-${n}`, roles: ['READER'] }, select: { id: true } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'T', urn: `${org.urn}:t` }, select: { id: true } });
  const other = await db.app.create({ data: { organizationId: org.id, name: 'O', urn: `${org.urn}:o` }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true } });
  zed = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: other.id, agentId: agent.id, name: 'Zed', slug: 'zed' }, select: { id: true } });
  session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, agentId: agent.id, userId: user.id }, select: { id: true } });
  task = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, status: 'backlog', closeSessionWhenDone: false }, select: { id: true } });
});

describe('the invariants file', () => {
  it('the migration carries a byte-identical copy, and post-push includes it', () => {
    const migration = readFileSync(new URL('../../../prisma/migrations/20261022100000_context_reset/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${SOURCE}`)).toBe(true);
    const post = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(post).toContain('\\ir context-reset-invariants.sql');
  });

  it('the CHECK\'s phases and reasons are exactly types.ts\'s sets, and the capability CHECK is HOST_CAPABILITIES', () => {
    const list = (re: RegExp) => [...(SOURCE.match(re)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(list(/phase IN \(([^)]*)\) AND\n/)).toEqual([...CONTEXT_RESET_PHASES]);
    expect(list(/reason IN \(([^)]*)\)\) AND/).sort()).toEqual([...CONTEXT_RESET_REFUSALS, ...CONTEXT_RESET_FAILURES].sort());
    expect(list(/capabilities <@ ARRAY\[([^\]]*)\]/)).toEqual([...HOST_CAPABILITIES]);
  });
});

describe('chk_context_resets_shape', () => {
  it('a reset no host could take is failed HOST_UNSUPPORTED; any other unissued shape is refused', async () => {
    await expect(row()).resolves.toBeTruthy();
    await expect(row({ phase: 'requested', reason: null, endedAt: null })).rejects.toThrow(check);
    await expect(row({ reason: 'PAUSED', phase: 'refused' })).rejects.toThrow(check);
  });

  it('a reason exactly when refused or failed; a reason outside the closed set; ended exactly when terminal', async () => {
    await expect(row({ reason: null })).rejects.toThrow(check);
    await expect(row({ reason: 'MADE_UP' })).rejects.toThrow(check);
    await expect(row({ endedAt: null })).rejects.toThrow(check);
  });

  it('every stamp a phase implies, and the stop lease only with a grant', async () => {
    const op = await db.hostOperation.create({
      data: { id: generateId(), appId: app.id, hostId: 'orca1', type: 'worker.reset-context', workerId: kit.id, args: { workerId: kit.id, sessionId: session.id, taskId: task.id, resetId: generateId() }, issuedBy: 'platform' },
    });
    const issued = { hostId: 'orca1', hostOperationId: op.id, reason: null, endedAt: null };
    await expect(row({ ...issued, phase: 'claimed' })).rejects.toThrow(check);
    await expect(row({ ...issued, phase: 'checkpointed', claimedAt: new Date() })).rejects.toThrow(check);
    await expect(row({ ...issued, phase: 'requested', stopLeaseMs: 15_000 })).rejects.toThrow(check);
    await expect(row({ ...issued, phase: 'requested', epoch: -1 })).rejects.toThrow(check);
    await expect(row({ ...issued, phase: 'requested' })).resolves.toBeTruthy();
  });
});

describe('the triggers', () => {
  it('a reset is for a worker of its own App', async () => {
    await expect(row({ workerId: zed.id })).rejects.toThrow(/chk_context_resets_same_app|not in the reset/);
  });

  it('an ended reset never moves; phases never move back; the epoch never moves back; the record is kept', async () => {
    const r = await row();
    await expect(db.contextReset.update({ where: { id: r.id }, data: { reason: 'PAUSED', phase: 'refused' } })).rejects.toThrow(/never moves again/);
    await db.contextReset.update({ where: { id: r.id }, data: { epoch: 2 } });
    await expect(db.contextReset.update({ where: { id: r.id }, data: { epoch: 1 } })).rejects.toThrow(/never moves back/);
    await expect(db.contextReset.update({ where: { id: r.id }, data: { taskId: generateId() } })).rejects.toThrow();
    await expect(db.contextReset.delete({ where: { id: r.id } })).rejects.toThrow(/kept as the record/);
  });
});

describe('the capability CHECK and the resetting mark', () => {
  it('a registration declares only known capabilities', async () => {
    await expect(db.hostRegistration.create({
      data: { id: generateId(), appId: app.id, hostId: 'orca1', label: 'O', pollIntervalSeconds: 60, registeredAt: new Date(), refreshedAt: new Date(), capabilities: ['worker.teleport'] } as any,
    })).rejects.toThrow(/chk_host_registrations_capabilities|23514|check constraint/);
  });

  it('`resetting` is set only by the context reset; clears_on_activity_after only on a resetting mark', async () => {
    const base = { workerId: kit.id, state: 'unavailable', setAt: new Date() };
    await expect(db.workerAvailability.create({ data: { ...base, reason: 'resetting', setBy: 'manager' } as any })).rejects.toThrow(/23514|check constraint/);
    await expect(db.workerAvailability.create({ data: { ...base, reason: 'other', setBy: 'manager', clearsOnActivityAfter: new Date() } as any })).rejects.toThrow(/23514|check constraint/);
    await expect(db.workerAvailability.create({ data: { ...base, reason: 'resetting', setBy: 'context-reset', clearsOnActivityAfter: new Date() } as any })).resolves.toBeTruthy();
  });
});
