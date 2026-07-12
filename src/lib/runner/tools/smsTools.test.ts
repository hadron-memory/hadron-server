/**
 * hadron_send_sms — DB-backed handler tests over a MOCKED smsClient seam
 * (the storeTools posture: the capability-tool HTTP client is the seam,
 * every governance layer is real).
 *
 * Pins the comprehensive-coverage requirement (Holger, 2026-07-12): the
 * policy chain gates the action name, BOTH sms.send counter scopes consume
 * with the launch gate's refund choreography, every send burns one
 * comm.outbound ticket (cor:acl:050:04 — outbound communication never
 * happens off-ledger), no governance layer is touched before validation,
 * and neither the destination number nor the body ever reaches the trail.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';

vi.mock('../../smsClient.js', () => ({
  sendSms: vi.fn(),
}));

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { sendSms } from '../../smsClient.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { evaluatePolicyChain, parsePolicyLink } from '@hadron-memory/access-control';
import { hadronSendSms, resolveRunTools } from './index.js';
import { maskPhoneNumber, MAX_SMS_BODY_CHARS } from './smsTools.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

const ORG_URN = 'sms-tool-org';
const TO = '+15551234567';

let orgId: string;
let appId: string;

async function mintRun(): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      appId,
      triggerKind: 'MANUAL',
      entryNodeUrn: `${ORG_URN}::mem::flow:entry`,
      status: 'RUNNING',
    },
  });
}

function toolCtx(run: AppRun): RunToolContext {
  return { log: vi.fn(), db, run, principal: runContext(db, run) };
}

/** Mint one unconsumed comm.outbound ticket for the org (app-agnostic). */
async function mintTicket(appScoped = false): Promise<string> {
  const id = generateId();
  await db.actionTicket.create({
    data: {
      id,
      organizationId: orgId,
      appId: appScoped ? appId : null,
      action: 'comm.outbound',
      mintedBy: 'test',
    },
  });
  return id;
}

async function quotaUsed(scopeKind: 'app' | 'org'): Promise<number | null> {
  const row = await db.quotaCounter.findFirst({
    where: { scopeKind, scopeId: scopeKind === 'app' ? appId : orgId, action: 'sms.send', window: 'day' },
  });
  return row?.used ?? null;
}

/** Pin the stored sms.send limit for a scope (creates the row when absent). */
async function setSmsLimit(scopeKind: 'app' | 'org', limit: number): Promise<void> {
  const scopeId = scopeKind === 'app' ? appId : orgId;
  const resetAt = new Date(Date.now() + 60 * 60 * 1000);
  const existing = await db.quotaCounter.findFirst({
    where: { scopeKind, scopeId, action: 'sms.send', window: 'day' },
  });
  if (existing) {
    await db.quotaCounter.update({ where: { id: existing.id }, data: { limit } });
  } else {
    await db.quotaCounter.create({
      data: { id: generateId(), scopeKind, scopeId, action: 'sms.send', window: 'day', used: 0, limit, resetAt },
    });
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sendSms).mockResolvedValue({ sid: 'SM123', status: 'queued' });
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: ORG_URN, urn: ORG_URN },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'sms-app', urn: `${ORG_URN}::sms-app` },
  });
  appId = app.id;
});

describe('hadron_send_sms registry + policy vocabulary', () => {
  it('is resolvable from the run-tool registry at cost 1 (the kernel gate debits the action budget)', () => {
    const { tools, unknown } = resolveRunTools(['hadron_send_sms']);
    expect(unknown).toEqual([]);
    const def = tools.find((t) => t.name === 'hadron_send_sms');
    expect(def?.cost).toBe(1);
  });

  it('tool.hadron_send_sms is deniable and allowable through the policy chain', () => {
    // The kernel derives the action generically (appRuns onToolCall). A
    // present link is default-deny over its allow-list: a chain that does
    // not name this tool denies it; exact and prefix entries allow it.
    const restrictive = parsePolicyLink({ allow: ['run.execute', 'llm.invoke'] });
    expect(evaluatePolicyChain('tool.hadron_send_sms', [restrictive])).toBe(false);
    expect(evaluatePolicyChain('tool.hadron_send_sms', [parsePolicyLink({ allow: ['tool.hadron_send_sms'] })])).toBe(true);
    expect(evaluatePolicyChain('tool.hadron_send_sms', [parsePolicyLink({ allow: ['tool.*'] })])).toBe(true);
    // Strict conjunction: ONE restrictive layer anywhere in the chain wins.
    expect(
      evaluatePolicyChain('tool.hadron_send_sms', [parsePolicyLink({ allow: ['*'] }), restrictive]),
    ).toBe(false);
  });
});

describe('hadron_send_sms input guards (before ANY governance touch)', () => {
  it.each([
    ['15551234567', 'hi'],
    ['+05551234567', 'hi'],
    ['not-a-number', 'hi'],
  ])('rejects non-E.164 destination %s without consuming quota or tickets', async (to, body) => {
    await mintTicket();
    const run = await mintRun();
    await expect(hadronSendSms.execute(toolCtx(run), { to, body })).rejects.toThrow(/E\.164/);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await quotaUsed('app')).toBeNull(); // no row was even created
    expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('rejects an empty and an oversized body', async () => {
    const run = await mintRun();
    const ctx = toolCtx(run);
    await expect(hadronSendSms.execute(ctx, { to: TO, body: '' })).rejects.toThrow(/1-1600/);
    await expect(
      hadronSendSms.execute(ctx, { to: TO, body: 'x'.repeat(MAX_SMS_BODY_CHARS + 1) }),
    ).rejects.toThrow(/1-1600/);
    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe('hadron_send_sms happy path', () => {
  it('sends, returns sid/status with a MASKED destination, consumes both counters and one ticket', async () => {
    const ticketId = await mintTicket();
    const run = await mintRun();
    const ctx = toolCtx(run);

    const out = (await hadronSendSms.execute(ctx, { to: TO, body: 'Deploy finished.' })) as Record<string, unknown>;

    expect(out.sent).toBe(true);
    expect(out.sid).toBe('SM123');
    expect(out.status).toBe('queued');
    expect(out.to).toBe(maskPhoneNumber(TO));
    expect(String(out.to)).not.toContain('123456'); // masked, not the number
    expect(sendSms).toHaveBeenCalledExactlyOnceWith({ to: TO, body: 'Deploy finished.' });

    // Tier 1: exactly one consumption per scope.
    expect(await quotaUsed('app')).toBe(1);
    expect(await quotaUsed('org')).toBe(1);

    // Tier 2: the ledger names the consuming run (auditable, cor:acl:050:01).
    const ticket = await db.actionTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.consumedAt).not.toBeNull();
    expect(ticket.consumedByRunId).toBe(run.id);
  });

  it('prefers an app-scoped ticket over an org-wide one', async () => {
    const orgTicket = await mintTicket(false);
    const appTicket = await mintTicket(true);
    const run = await mintRun();
    await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' });
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: appTicket } })).consumedAt).not.toBeNull();
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: orgTicket } })).consumedAt).toBeNull();
  });
});

describe('hadron_send_sms quota exhaustion (tier 1)', () => {
  it('app quota exhausted → LLM-visible error, no send, no ticket burned', async () => {
    await mintTicket();
    await setSmsLimit('app', 0);
    const run = await mintRun();
    const out = (await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect(String(out.error)).toMatch(/App is exhausted/);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
    expect(await quotaUsed('app')).toBe(0); // atomic denial, nothing consumed
  });

  it('org quota exhausted → LLM-visible error AND the app counter is refunded', async () => {
    await mintTicket();
    await setSmsLimit('org', 0);
    const run = await mintRun();
    const out = (await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect(String(out.error)).toMatch(/organization is exhausted/);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await quotaUsed('app')).toBe(0); // consumed then refunded
    expect(await quotaUsed('org')).toBe(0);
  });

  it('sends up to the stored app limit, then denies', async () => {
    await mintTicket();
    await mintTicket();
    await mintTicket();
    await setSmsLimit('app', 2);
    const run = await mintRun();
    const ctx = toolCtx(run);
    expect(((await hadronSendSms.execute(ctx, { to: TO, body: '1' })) as Record<string, unknown>).sent).toBe(true);
    expect(((await hadronSendSms.execute(ctx, { to: TO, body: '2' })) as Record<string, unknown>).sent).toBe(true);
    const third = (await hadronSendSms.execute(ctx, { to: TO, body: '3' })) as Record<string, unknown>;
    expect(third.isError).toBe(true);
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(await quotaUsed('app')).toBe(2);
  });
});

describe('hadron_send_sms ticket ledger (tier 2, cor:acl:050:04)', () => {
  it('no comm.outbound ticket → the send is SKIPPED and both counters are refunded', async () => {
    const run = await mintRun();
    const ctx = toolCtx(run);
    const out = (await hadronSendSms.execute(ctx, { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect(String(out.error)).toMatch(/ticket/);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await quotaUsed('app')).toBe(0);
    expect(await quotaUsed('org')).toBe(0);
    expect(vi.mocked(ctx.log).mock.calls.some(([m]) => m.includes('no comm.outbound ticket'))).toBe(true);
  });

  it('an expired ticket does not authorize a send', async () => {
    const id = generateId();
    await db.actionTicket.create({
      data: {
        id, organizationId: orgId, appId: null, action: 'comm.outbound',
        mintedBy: 'test', expiresAt: new Date(Date.now() - 1000),
      },
    });
    const run = await mintRun();
    const out = (await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("another org's ticket never authorizes this org's send (cross-tenant isolation)", async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    await db.actionTicket.create({
      data: {
        id: generateId(), organizationId: otherOrg.id, appId: null,
        action: 'comm.outbound', mintedBy: 'test',
      },
    });
    const run = await mintRun();
    const out = (await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('the ticket stays consumed when the provider rejects (the attempt happened — honest ledger)', async () => {
    const ticketId = await mintTicket();
    vi.mocked(sendSms).mockRejectedValue(
      new GraphQLError('Twilio rejected the message (error 21211): invalid To.', {
        extensions: { code: 'SMS_TOOL_ERROR', smsErrorCode: 'provider_rejected' },
      }),
    );
    const run = await mintRun();
    const out = (await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: ticketId } })).consumedAt).not.toBeNull();
    expect(await quotaUsed('app')).toBe(1);
  });
});

describe('hadron_send_sms provider/transport failure posture', () => {
  it('a tool-level rejection returns an LLM-visible error carrying smsErrorCode (never retried)', async () => {
    await mintTicket();
    vi.mocked(sendSms).mockRejectedValue(
      new GraphQLError('Twilio rejected the message (error 21211): invalid To.', {
        extensions: { code: 'SMS_TOOL_ERROR', smsErrorCode: 'provider_rejected' },
      }),
    );
    const run = await mintRun();
    const out = (await hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })) as Record<string, unknown>;
    expect(out.isError).toBe(true);
    expect(out.smsErrorCode).toBe('provider_rejected');
    expect(String(out.error)).toMatch(/Do not retry/);
    expect(sendSms).toHaveBeenCalledTimes(1); // exactly one attempt, ever
  });

  it('a transport failure (tool unreachable) throws → TOOL_FAILED', async () => {
    await mintTicket();
    vi.mocked(sendSms).mockRejectedValue(
      new GraphQLError('SMS tool is unreachable.', { extensions: { code: 'SMS_TOOL_UNREACHABLE' } }),
    );
    const run = await mintRun();
    await expect(hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })).rejects.toThrow(/unreachable/);
  });

  it('a missing tool configuration throws → TOOL_FAILED (deployment problem, not author problem)', async () => {
    await mintTicket();
    vi.mocked(sendSms).mockRejectedValue(
      new GraphQLError('SMS sending is not configured (TWILIO_TOOL_URL unset).', {
        extensions: { code: 'SMS_TOOL_NOT_CONFIGURED' },
      }),
    );
    const run = await mintRun();
    await expect(hadronSendSms.execute(toolCtx(run), { to: TO, body: 'hi' })).rejects.toThrow(/not configured/);
  });
});

describe('hadron_send_sms PII posture', () => {
  it('trail lines carry the masked number and never the body', async () => {
    await mintTicket();
    const run = await mintRun();
    const ctx = toolCtx(run);
    const secret = 'the-secret-message-body';
    await hadronSendSms.execute(ctx, { to: TO, body: secret });
    const trail = vi.mocked(ctx.log).mock.calls.map(([m]) => m).join('\n');
    expect(trail).toContain(maskPhoneNumber(TO));
    expect(trail).not.toContain(TO);
    expect(trail).not.toContain(secret);
  });
});
