import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';

vi.mock('../../resendToolClient.js', () => ({
  sendResendEmail: vi.fn(),
  isResendToolConfigured: vi.fn(() => true),
}));

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { isResendToolConfigured, sendResendEmail } from '../../resendToolClient.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { evaluatePolicyChain, parsePolicyLink } from '@hadron-memory/access-control';
import { hadronSendEmail, resolveRunTools } from './index.js';
import { maskEmailAddress, MAX_EMAIL_SUBJECT_CHARS, MAX_EMAIL_TEXT_CHARS } from './emailTools.js';
import { encryptResendApiKey } from '../../resendSenders.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

const ORG_URN = 'email-tool-org';
const TO = 'person@example.net';

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
    where: { scopeKind, scopeId: scopeKind === 'app' ? appId : orgId, action: 'email.send', window: 'day' },
  });
  return row?.used ?? null;
}

async function setEmailLimit(scopeKind: 'app' | 'org', limit: number): Promise<void> {
  const scopeId = scopeKind === 'app' ? appId : orgId;
  const resetAt = new Date(Date.now() + 60 * 60 * 1000);
  const existing = await db.quotaCounter.findFirst({
    where: { scopeKind, scopeId, action: 'email.send', window: 'day' },
  });
  if (existing) {
    await db.quotaCounter.update({ where: { id: existing.id }, data: { limit } });
  } else {
    await db.quotaCounter.create({
      data: { id: generateId(), scopeKind, scopeId, action: 'email.send', window: 'day', used: 0, limit, resetAt },
    });
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sendResendEmail).mockResolvedValue({ id: 'email_123' });
  vi.mocked(isResendToolConfigured).mockReturnValue(true);
  delete process.env.RESEND_PLATFORM_ORG_IDS;
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: ORG_URN, urn: ORG_URN } });
  orgId = org.id;
  await db.resendSender.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      fromAddress: 'Acme Agent <agent@acme.example>',
      apiKeyEncrypted: encryptResendApiKey('re_org_secret'),
    },
  });
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'email-app', urn: `${ORG_URN}::email-app` },
  });
  appId = app.id;
});

afterEach(() => {
  delete process.env.RESEND_PLATFORM_ORG_IDS;
});

describe('hadron_send_email registry + policy vocabulary', () => {
  it('is resolvable at action cost 1', () => {
    const { tools, unknown } = resolveRunTools(['hadron_send_email']);
    expect(unknown).toEqual([]);
    expect(tools.find((tool) => tool.name === 'hadron_send_email')?.cost).toBe(1);
  });

  it('tool.hadron_send_email is controlled by the policy chain', () => {
    const restrictive = parsePolicyLink({ allow: ['run.execute', 'llm.invoke'] });
    expect(evaluatePolicyChain('tool.hadron_send_email', [restrictive])).toBe(false);
    expect(
      evaluatePolicyChain('tool.hadron_send_email', [parsePolicyLink({ allow: ['tool.hadron_send_email'] })]),
    ).toBe(true);
    expect(evaluatePolicyChain('tool.hadron_send_email', [parsePolicyLink({ allow: ['tool.*'] })])).toBe(true);
  });
});

describe('hadron_send_email input and config guards', () => {
  it.each(['not-email', 'two@example.com,other@example.com', 'x@y'])('rejects invalid recipient %s', async (to) => {
    await mintTicket();
    const run = await mintRun();
    await expect(hadronSendEmail.execute(toolCtx(run), { to, subject: 'Hi', text: 'Body' })).rejects.toThrow(
      /valid email/,
    );
    expect(sendResendEmail).not.toHaveBeenCalled();
    expect(await quotaUsed('app')).toBeNull();
  });

  it('rejects invalid subject and body lengths before governance', async () => {
    const run = await mintRun();
    const ctx = toolCtx(run);
    await expect(hadronSendEmail.execute(ctx, { to: TO, subject: 'bad\nsubject', text: 'Body' })).rejects.toThrow(
      /subject/,
    );
    await expect(
      hadronSendEmail.execute(ctx, { to: TO, subject: 'x'.repeat(MAX_EMAIL_SUBJECT_CHARS + 1), text: 'Body' }),
    ).rejects.toThrow(/subject/);
    await expect(hadronSendEmail.execute(ctx, { to: TO, subject: 'Hi', text: '' })).rejects.toThrow(/text/);
    await expect(
      hadronSendEmail.execute(ctx, { to: TO, subject: 'Hi', text: 'x'.repeat(MAX_EMAIL_TEXT_CHARS + 1) }),
    ).rejects.toThrow(/text/);
    expect(sendResendEmail).not.toHaveBeenCalled();
  });

  it('fails unconfigured before consuming quota or a ticket', async () => {
    await mintTicket();
    vi.mocked(isResendToolConfigured).mockReturnValue(false);
    const run = await mintRun();
    await expect(hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })).rejects.toThrow(
      /not configured/,
    );
    expect(await quotaUsed('app')).toBeNull();
    expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('requires an enabled org sender when platform fallback is not allowlisted', async () => {
    await mintTicket();
    await db.resendSender.delete({ where: { organizationId: orgId } });
    const run = await mintRun();
    await expect(hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })).rejects.toMatchObject({
      extensions: { code: 'RESEND_SENDER_NOT_CONFIGURED' },
    });
    expect(sendResendEmail).not.toHaveBeenCalled();
    expect(await quotaUsed('app')).toBeNull();
    expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('treats a disabled org sender as unavailable before governance', async () => {
    await db.resendSender.update({ where: { organizationId: orgId }, data: { enabled: false } });
    process.env.RESEND_PLATFORM_ORG_IDS = orgId;
    const run = await mintRun();
    await expect(hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })).rejects.toThrow(
      /disabled/,
    );
    expect(await quotaUsed('app')).toBeNull();
  });
});

describe('hadron_send_email governed send', () => {
  it('sends once, consumes both quotas and one ticket, and passes deterministic idempotency', async () => {
    const ticketId = await mintTicket();
    const run = await mintRun();
    const ctx = toolCtx(run);
    const input = { to: TO, subject: 'Deploy finished', text: 'Everything is healthy.' };
    const out = (await hadronSendEmail.execute(ctx, input)) as Record<string, unknown>;

    expect(out).toMatchObject({ sent: true, id: 'email_123', to: maskEmailAddress(TO) });
    expect(await quotaUsed('app')).toBe(1);
    expect(await quotaUsed('org')).toBe(1);
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: ticketId } })).consumedByRunId).toBe(run.id);
    const sent = vi.mocked(sendResendEmail).mock.calls[0][0];
    const credentials = vi.mocked(sendResendEmail).mock.calls[0][1];
    expect(sent).toMatchObject(input);
    expect(credentials).toEqual({ apiKey: 're_org_secret', from: 'Acme Agent <agent@acme.example>' });
    expect(sent.idempotencyKey).toMatch(new RegExp(`^email:${run.id}:[0-9a-f]{32}$`));

    await mintTicket();
    await hadronSendEmail.execute(ctx, input);
    expect(vi.mocked(sendResendEmail).mock.calls[1][0].idempotencyKey).toBe(sent.idempotencyKey);
  });

  it('uses the platform account only for an explicitly allowlisted org', async () => {
    await db.resendSender.delete({ where: { organizationId: orgId } });
    process.env.RESEND_PLATFORM_ORG_IDS = `other-org, ${orgId}`;
    await mintTicket();
    const run = await mintRun();
    await hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' });
    expect(sendResendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendResendEmail).mock.calls[0][1]).toBeUndefined();
  });

  it('prefers an app-scoped ticket over an org-wide ticket', async () => {
    const orgTicket = await mintTicket(false);
    const appTicket = await mintTicket(true);
    const run = await mintRun();
    await hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' });
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: appTicket } })).consumedAt).not.toBeNull();
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: orgTicket } })).consumedAt).toBeNull();
  });

  it('denies at app quota without burning a ticket', async () => {
    await mintTicket();
    await setEmailLimit('app', 0);
    const run = await mintRun();
    const out = (await hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })) as Record<
      string,
      unknown
    >;
    expect(out.isError).toBe(true);
    expect(sendResendEmail).not.toHaveBeenCalled();
    expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('refunds app quota when org quota denies', async () => {
    await mintTicket();
    await setEmailLimit('org', 0);
    const run = await mintRun();
    const out = (await hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })) as Record<
      string,
      unknown
    >;
    expect(out.isError).toBe(true);
    expect(await quotaUsed('app')).toBe(0);
    expect(await quotaUsed('org')).toBe(0);
  });

  it('refunds both quotas when no comm.outbound ticket exists', async () => {
    const run = await mintRun();
    const out = (await hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })) as Record<
      string,
      unknown
    >;
    expect(out.isError).toBe(true);
    expect(String(out.error)).toMatch(/ticket/);
    expect(await quotaUsed('app')).toBe(0);
    expect(await quotaUsed('org')).toBe(0);
    expect(sendResendEmail).not.toHaveBeenCalled();
  });
});

describe('hadron_send_email failure and privacy posture', () => {
  it('turns provider rejection into an LLM-visible typed error and keeps governance consumed', async () => {
    const ticketId = await mintTicket();
    vi.mocked(sendResendEmail).mockRejectedValue(
      new GraphQLError('Resend rejected the email.', {
        extensions: { code: 'RESEND_TOOL_ERROR', emailErrorCode: 'provider_rejected' },
      }),
    );
    const run = await mintRun();
    const out = (await hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' })) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({ isError: true, emailErrorCode: 'provider_rejected' });
    expect(String(out.error)).toMatch(/Do not retry/);
    expect((await db.actionTicket.findUniqueOrThrow({ where: { id: ticketId } })).consumedAt).not.toBeNull();
    expect(await quotaUsed('app')).toBe(1);
    expect(sendResendEmail).toHaveBeenCalledTimes(1);
  });

  it('throws transport failure for the kernel to mark TOOL_FAILED', async () => {
    await mintTicket();
    vi.mocked(sendResendEmail).mockRejectedValue(
      new GraphQLError('Resend tool is unreachable.', { extensions: { code: 'RESEND_TOOL_UNREACHABLE' } }),
    );
    const run = await mintRun();
    await expect(
      hadronSendEmail.execute(toolCtx(run), { to: TO, subject: 'Hi', text: 'Body' }),
    ).rejects.toThrow(/unreachable/);
  });

  it('never places recipient, subject, or body in the run trail', async () => {
    await mintTicket();
    const run = await mintRun();
    const ctx = toolCtx(run);
    const subject = 'private subject';
    const text = 'private body';
    await hadronSendEmail.execute(ctx, { to: TO, subject, text });
    const trail = vi.mocked(ctx.log).mock.calls.map(([message]) => message).join('\n');
    expect(trail).toContain(maskEmailAddress(TO));
    expect(trail).not.toContain(TO);
    expect(trail).not.toContain(subject);
    expect(trail).not.toContain(text);
  });
});
