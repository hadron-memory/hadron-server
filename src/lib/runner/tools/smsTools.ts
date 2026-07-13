/**
 * SMS tools (hadrontool-twilio): hadron_send_sms — send ONE outbound SMS
 * through the platform Twilio account via the internal SMS capability tool.
 *
 * Intent: internal/staff notifications, not a mass-campaign channel. That is
 * deliberately NOT a hard rule — the enforcement is the layered governance
 * below (Holger, 2026-07-12).
 *
 * Governance — outbound communication is the most-gated action class:
 *  1. Policy chain: the kernel gates every call via
 *     checkActivation('tool.hadron_send_sms', {actionCost: 1}) — the tool
 *     must be activated for the run AND the run must have action-budget
 *     headroom (cor:agt:010:02).
 *  2. Daily counters (cor:acl:050:04 tier 1): each send consumes `sms.send`
 *     at BOTH the app and org scope — the mass-messaging brake. The env
 *     values (QUOTA_SMS_PER_DAY_APP/ORG) only seed first touch; operators
 *     tune the QuotaCounter rows.
 *  3. Ticket ledger (cor:acl:050:04 tier 2): an SMS irreversibly leaves the
 *     platform, so each send burns ONE `comm.outbound` ActionTicket — the
 *     same ledger webhook callbacks draw on. No ticket ⇒ the send is
 *     SKIPPED and the model is told why (outbound communication never
 *     happens off-ledger).
 *
 * Failure posture (the mcpTools convention): governance denials and
 * provider-level rejections return `{isError: true, ...}` so the LLM sees
 * them and adapts; transport failures throw → TOOL_FAILED. NEVER retry a
 * send — the tool is stateless (no idempotency ledger) and a retry can
 * double-message a human.
 *
 * PII posture: the destination number is MASKED and the body is never
 * logged — trail lines carry the masked number + body length only.
 */

import { GraphQLError } from 'graphql';
import {
  consumeQuota,
  consumeActionTicket,
  defaultQuotaLimit,
} from '../../../jobs/appRuns.js';
import { isSmsConfigured, sendSms } from '../../smsClient.js';
import type { RunToolDef } from './types.js';
import type { PrismaClient } from '../../../generated/prisma/index.js';

/** E.164: +, leading non-zero digit, 15 digits max. */
const E164_RE = /^\+[1-9]\d{1,14}$/;

/** Twilio's hard cap on an outbound message body (concatenated segments). */
export const MAX_SMS_BODY_CHARS = 1_600;

/**
 * `+15551234567` → `+1•••4567` — enough to recognize, never the number.
 * Short-but-valid E.164 values (some countries have 5-7 digit numbers)
 * would leak via the tail slice, so they mask to the prefix only
 * (PR-642 review, Gemini + Copilot).
 */
export function maskPhoneNumber(to: string): string {
  if (to.length < 8) return `${to.slice(0, 2)}•••`;
  return `${to.slice(0, 2)}•••${to.slice(-4)}`;
}

/** Undo one `sms.send` consumption (org-denied / no-ticket compensation). */
async function refundSmsQuota(db: PrismaClient, scopeKind: 'app' | 'org', scopeId: string): Promise<void> {
  await db.quotaCounter.updateMany({
    where: { scopeKind, scopeId, action: 'sms.send', window: 'day', used: { gt: 0 } },
    data: { used: { decrement: 1 } },
  });
}

export const hadronSendSms: RunToolDef = {
  name: 'hadron_send_sms',
  description:
    'Send ONE SMS text message to a phone number. Intended for internal/staff ' +
    'notifications (alerts, reminders, briefing pings) — not bulk messaging: every ' +
    'send draws on the daily SMS quotas and burns one outbound-communication ticket. ' +
    'The send is not retried on failure; a governance denial or provider rejection ' +
    'comes back as an error result to adapt to.',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Destination phone number in E.164 format, e.g. "+15551234567".',
      },
      body: {
        type: 'string',
        description: `The message text (1-${MAX_SMS_BODY_CHARS} characters).`,
      },
    },
    required: ['to', 'body'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const to = String(args.to ?? '').trim();
    const body = typeof args.body === 'string' ? args.body : '';
    if (!E164_RE.test(to)) {
      throw new Error('hadron_send_sms: "to" must be an E.164 phone number, e.g. "+15551234567".');
    }
    if (body.length === 0 || body.length > MAX_SMS_BODY_CHARS) {
      throw new Error(`hadron_send_sms: "body" must be 1-${MAX_SMS_BODY_CHARS} characters.`);
    }
    // Config preflight BEFORE any governance touch: an unconfigured
    // deployment must not drain the scarce counters/ticket ledger on
    // attempts that can never leave the platform (PR-642 review, Codex P2).
    if (!isSmsConfigured()) {
      throw new GraphQLError('SMS sending is not configured (TWILIO_TOOL_URL unset).', {
        extensions: { code: 'SMS_TOOL_NOT_CONFIGURED' },
      });
    }
    const masked = maskPhoneNumber(to);

    // Tier 1 — daily counters, app scope then org scope, with the launch
    // gate's refund choreography (an org denial must not leave the app
    // counter consumed; mintAppRun's run.execute pattern).
    const { db, run } = ctx;
    if (!(await consumeQuota(db, 'app', run.appId, 'sms.send', defaultQuotaLimit('app', 'sms.send')))) {
      ctx.log(`hadron_send_sms: skipped — app SMS quota exhausted (to ${masked})`);
      return { isError: true, error: 'Daily SMS quota for this App is exhausted. Do not retry today.' };
    }
    if (!(await consumeQuota(db, 'org', run.organizationId, 'sms.send', defaultQuotaLimit('org', 'sms.send')))) {
      await refundSmsQuota(db, 'app', run.appId);
      ctx.log(`hadron_send_sms: skipped — organization SMS quota exhausted (to ${masked})`);
      return { isError: true, error: 'Daily SMS quota for this organization is exhausted. Do not retry today.' };
    }

    // Tier 2 — the outbound-communication ticket ledger (cor:acl:050:04:
    // an SMS irreversibly leaves the platform; no ticket ⇒ no send). The
    // counters above are refunded — no attempt happened.
    if (!(await consumeActionTicket(db, run.organizationId, run.appId, 'comm.outbound', run.id))) {
      await refundSmsQuota(db, 'app', run.appId);
      await refundSmsQuota(db, 'org', run.organizationId);
      ctx.log(`hadron_send_sms: skipped — no comm.outbound ticket (to ${masked})`);
      return {
        isError: true,
        error:
          'No outbound-communication ticket is available for this run. The send was ' +
          'skipped; an operator must grant comm.outbound tickets. Do not retry.',
      };
    }

    // The attempt happens now — from here on, ticket and counters stay
    // consumed regardless of outcome (the honest ledger; webhook posture).
    let result;
    try {
      result = await sendSms({ to, body });
    } catch (err) {
      if (err instanceof GraphQLError && err.extensions?.code === 'SMS_TOOL_ERROR') {
        // Tool-level rejection (bad number, unauthorized account, rate
        // limit…) — the model should see it and adapt, not TOOL_FAIL.
        const smsErrorCode = typeof err.extensions.smsErrorCode === 'string' ? err.extensions.smsErrorCode : undefined;
        ctx.log(`hadron_send_sms: rejected${smsErrorCode ? ` (${smsErrorCode})` : ''} (to ${masked})`);
        return {
          isError: true,
          error: `The SMS was not sent: ${err.message} Do not retry with the same input.`,
          ...(smsErrorCode ? { smsErrorCode } : {}),
        };
      }
      // SMS_TOOL_NOT_CONFIGURED / SMS_TOOL_UNREACHABLE: deployment problems,
      // not author problems — fail the hop loud (TOOL_FAILED).
      throw err;
    }

    ctx.log(`hadron_send_sms: sent to ${masked} (${body.length} chars, sid ${result.sid})`);
    return { sent: true, sid: result.sid, status: result.status, to: masked };
  },
};

export const SMS_TOOLS: readonly RunToolDef[] = [hadronSendSms];
