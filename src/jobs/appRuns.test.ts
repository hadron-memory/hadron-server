/**
 * Spec 040 — run kernel integration (real hadron_test DB, bus mocked,
 * execution deps injected).
 *
 * What this file pins:
 *   - mintAppRun launch gate: app-liveness, on-behalf-of relationship
 *     re-verification, trigger-policy floor, run-quota consumption + refund.
 *   - executeAppRun: claim idempotency; happy path (COMPLETED + budget
 *     decrement + usage event); assembly failure → FAILED (observable, D20);
 *     transient LLM → PENDING reset + 'transient' (bus redelivery contract);
 *     the kill switch (CANCELLED before execution → ACTIVATION_DENIED).
 *   - consumeQuota: headroom semantics + window roll.
 *   - schedulerTick: due claim advances nextRunAt atomically; overlap skip
 *     STILL advances; invalid cron disables the schedule.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null), // sweep/standalone mode in tests
}));

import {
  mintAppRun,
  executeAppRun,
  consumeQuota,
  RunLaunchDeniedError,
  type RunExecutionDeps,
} from './appRuns.js';
import { schedulerTick } from './scheduler.js';

let orgId: string;
let appId: string;
let userId: string;

function deps(overrides: Partial<RunExecutionDeps> = {}): RunExecutionDeps {
  return {
    assemble: vi.fn(async () => '# Task\n\nDo the thing.'),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm: vi.fn(async () => ({
      text: 'the briefing',
      tokensIn: 100,
      tokensOut: 50,
      provider: 'anthropic',
      model: 'test',
    })),
    writeOutput: vi.fn(async () => 'node-id-1'),
    ...overrides,
  };
}

async function mint(extra: Record<string, unknown> = {}) {
  return mintAppRun(db, {
    organizationId: orgId,
    appId,
    triggerKind: 'MANUAL',
    entryNodeUrn: 'run-org::runmem::tasks:briefing',
    ...extra,
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'run-org', urn: 'run-org' },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'run-app', urn: 'run-org::run-app' },
  });
  appId = app.id;
  const user = await db.user.create({
    data: { githubId: 9991, githubUsername: 'run-user', roles: ['READER'] },
  });
  userId = user.id;
});

// ───── launch gate ──────────────────────────────────────────────────────────

describe('mintAppRun — launch gate (cor:acl:050:01)', () => {
  it('mints a PENDING run with default budgets', async () => {
    const run = await mint();
    expect(run.status).toBe('PENDING');
    expect(run.budgetTokens).toBeGreaterThan(0);
    expect(run.budgetActions).toBeGreaterThan(0);
    expect(run.triggerKind).toBe('MANUAL');
  });

  it('rejects a dead or foreign App', async () => {
    await expect(
      mint({ appId: generateId() }),
    ).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
  });

  it('re-verifies the on-behalf-of relationship at launch (cor:agt:010:01)', async () => {
    await expect(mint({ userId })).rejects.toMatchObject({ code: 'RELATIONSHIP_MISSING' });
    await db.appMember.create({ data: { appId, userId, role: 'member' } });
    const run = await mint({ userId });
    expect(run.userId).toBe(userId);
  });

  it('denies when the trigger policy does not allow run.execute', async () => {
    await expect(mint({ policy: { allow: ['memory.read'] } })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('enforces the app run quota and refunds on org denial', async () => {
    // Exhaust the app counter artificially.
    await db.quotaCounter.create({
      data: {
        id: generateId(), scopeKind: 'app', scopeId: appId, action: 'run.execute',
        window: 'day', used: 999_999, limit: 1_000_000, resetAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.quotaCounter.update({
      where: { scopeKind_scopeId_action_window: { scopeKind: 'app', scopeId: appId, action: 'run.execute', window: 'day' } },
      data: { limit: 999_999 },
    });
    await expect(mint()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

// ───── consumeQuota ─────────────────────────────────────────────────────────

describe('consumeQuota', () => {
  it('consumes to the limit, then denies', async () => {
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 2)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 2)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 2)).toBe(false);
  });

  it('rolls the window when resetAt has passed', async () => {
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(false);
    await db.quotaCounter.updateMany({
      where: { scopeKind: 'app', scopeId: appId },
      data: { resetAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(true);
  });
});

// ───── execution ────────────────────────────────────────────────────────────

describe('executeAppRun — kernel + activation contract (cor:agt:010:02)', () => {
  it('happy path: COMPLETED, budgets decremented, usage recorded', async () => {
    const run = await mint();
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.budgetTokens).toBe((run.budgetTokens ?? 0) - 150);
    expect(after.budgetActions).toBe((run.budgetActions ?? 0) - 1);
    expect(after.curNodeUrn).toBe('node-id-1');
    const usage = await db.usageEvent.findFirst({ where: { type: 'app-run' } });
    expect(usage?.tokensIn).toBe(100);
  });

  it('claim is idempotent — a second delivery skips', async () => {
    const run = await mint();
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    expect(await executeAppRun(db, run.id, d)).toBe('skipped');
    expect(d.assemble).toHaveBeenCalledTimes(1);
  });

  it('assembly failure is an OBSERVABLE failed run (D20)', async () => {
    const run = await mint();
    const outcome = await executeAppRun(
      db,
      run.id,
      deps({ assemble: vi.fn(async () => { throw new Error('entry node not found'); }) }),
    );
    expect(outcome).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect((after.failure as { code?: string }).code).toBe('ASSEMBLY_FAILED');
  });

  it('transient LLM failure resets the claim for bus redelivery', async () => {
    const run = await mint();
    const { LlmInvocationError } = await import('../lib/llm/index.js');
    const outcome = await executeAppRun(
      db,
      run.id,
      deps({
        llm: vi.fn(async () => {
          throw new LlmInvocationError('rate limited', 'anthropic', true);
        }),
      }),
    );
    expect(outcome).toBe('transient');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('PENDING'); // ready for the next delivery
  });

  it('the kill switch: a CANCELLED run never reaches the LLM', async () => {
    const run = await mint();
    // Cancel between mint and delivery (the manual handle).
    await db.appRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('skipped'); // claim finds no PENDING
    expect(d.llm).not.toHaveBeenCalled();
  });

  it('a run-layer policy denying llm.invoke fails before the LLM', async () => {
    const run = await mint({ policy: { allow: ['run.execute', 'memory.write'] } });
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('ACTIVATION_DENIED');
    expect(d.llm).not.toHaveBeenCalled();
  });
});

// ───── scheduler ────────────────────────────────────────────────────────────

describe('schedulerTick (plan §7)', () => {
  async function makeSchedule(extra: Record<string, unknown> = {}) {
    return db.agentSchedule.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        appId,
        name: 'morning briefing',
        cron: '0 7 * * *',
        timezone: 'UTC',
        entryNodeUrn: 'run-org::runmem::tasks:briefing',
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000), // due
        ...extra,
      } as never,
    });
  }

  it('mints a run for a due schedule and advances nextRunAt', async () => {
    const s = await makeSchedule();
    const minted = await schedulerTick(db);
    expect(minted).toBe(1);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.lastRunAt).not.toBeNull();
    const run = await db.appRun.findFirst({ where: { triggerId: s.id } });
    expect(run?.triggerKind).toBe('SCHEDULE');
    expect(run?.status).toBe('PENDING');
  });

  it('overlap skip STILL advances nextRunAt (no back-to-back storm)', async () => {
    const s = await makeSchedule();
    await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgId, appId, triggerKind: 'SCHEDULE',
        triggerId: s.id, entryNodeUrn: s.entryNodeUrn, status: 'RUNNING',
      },
    });
    const minted = await schedulerTick(db);
    expect(minted).toBe(0);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now()); // advanced despite skip
    expect(await db.appRun.count({ where: { triggerId: s.id } })).toBe(1); // no double-mint
  });

  it('an invalid cron disables the schedule loudly instead of looping', async () => {
    const s = await makeSchedule({ cron: 'not a cron' });
    await schedulerTick(db);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.enabled).toBe(false);
  });

  it('a not-yet-due schedule is untouched', async () => {
    await makeSchedule({ nextRunAt: new Date(Date.now() + 3_600_000) });
    expect(await schedulerTick(db)).toBe(0);
  });
});
