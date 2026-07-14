import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import {
  consumeActionTicket,
  consumeQuota,
  defaultQuotaLimit,
} from '../../../jobs/appRuns.js';
import { isResendToolConfigured, sendResendEmail } from '../../resendToolClient.js';
import { decryptResendCredentials, isPlatformResendAllowed } from '../../resendSenders.js';
import type { PrismaClient } from '../../../generated/prisma/index.js';
import type { RunToolDef } from './types.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_SUBJECT_CHARS = 200;
export const MAX_EMAIL_TEXT_CHARS = 20_000;

export function maskEmailAddress(address: string): string {
  const [local, domain = ''] = address.split('@');
  return `${local.slice(0, 1)}•••@${domain.slice(0, 1)}•••`;
}

function idempotencyKey(runId: string, to: string, subject: string, text: string): string {
  const digest = createHash('sha256')
    .update(to)
    .update('\0')
    .update(subject)
    .update('\0')
    .update(text)
    .digest('hex');
  return `email:${runId}:${digest.slice(0, 32)}`;
}

async function refundEmailQuota(db: PrismaClient, scopeKind: 'app' | 'org', scopeId: string): Promise<void> {
  await db.quotaCounter.updateMany({
    where: { scopeKind, scopeId, action: 'email.send', window: 'day', used: { gt: 0 } },
    data: { used: { decrement: 1 } },
  });
}

export const hadronSendEmail: RunToolDef = {
  name: 'hadron_send_email',
  description:
    'Send ONE plain-text email to one recipient through the platform Resend account. ' +
    'Every send draws on daily App and organization email quotas and burns one ' +
    'outbound-communication ticket. HTML, attachments, CC, and BCC are not supported. ' +
    'Provider failures are not retried.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', format: 'email', description: 'The single recipient email address.' },
      subject: { type: 'string', description: `Subject (1-${MAX_EMAIL_SUBJECT_CHARS} characters; no newlines).` },
      text: { type: 'string', description: `Plain-text body (1-${MAX_EMAIL_TEXT_CHARS} characters).` },
    },
    required: ['to', 'subject', 'text'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const to = String(args.to ?? '').trim();
    const subject = typeof args.subject === 'string' ? args.subject : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!EMAIL_RE.test(to) || /[\r\n]/.test(to)) {
      throw new Error('hadron_send_email: "to" must be one valid email address.');
    }
    if (subject.length === 0 || subject.length > MAX_EMAIL_SUBJECT_CHARS || /[\r\n]/.test(subject)) {
      throw new Error(`hadron_send_email: "subject" must be 1-${MAX_EMAIL_SUBJECT_CHARS} characters with no newlines.`);
    }
    if (text.length === 0 || text.length > MAX_EMAIL_TEXT_CHARS) {
      throw new Error(`hadron_send_email: "text" must be 1-${MAX_EMAIL_TEXT_CHARS} characters.`);
    }
    if (!isResendToolConfigured()) {
      throw new GraphQLError('Agent email sending is not configured (RESEND_TOOL_URL unset).', {
        extensions: { code: 'RESEND_TOOL_NOT_CONFIGURED' },
      });
    }

    const { db, run } = ctx;
    const sender = await db.resendSender.findUnique({ where: { organizationId: run.organizationId } });
    if (sender && !sender.enabled) {
      throw new GraphQLError('This organization\'s Resend sender is disabled.', {
        extensions: { code: 'RESEND_SENDER_NOT_CONFIGURED' },
      });
    }
    const credentials = sender ? decryptResendCredentials(sender) : undefined;
    const platformAllowed = !sender && isPlatformResendAllowed(run.organizationId);
    if (!credentials && !platformAllowed) {
      throw new GraphQLError('This organization has no Resend sender configured.', {
        extensions: { code: 'RESEND_SENDER_NOT_CONFIGURED' },
      });
    }

    const masked = maskEmailAddress(to);
    if (!(await consumeQuota(db, 'app', run.appId, 'email.send', defaultQuotaLimit('app', 'email.send')))) {
      ctx.log(`hadron_send_email: skipped — app email quota exhausted (to ${masked})`);
      return { isError: true, error: 'Daily email quota for this App is exhausted. Do not retry today.' };
    }
    if (!(await consumeQuota(db, 'org', run.organizationId, 'email.send', defaultQuotaLimit('org', 'email.send')))) {
      await refundEmailQuota(db, 'app', run.appId);
      ctx.log(`hadron_send_email: skipped — organization email quota exhausted (to ${masked})`);
      return { isError: true, error: 'Daily email quota for this organization is exhausted. Do not retry today.' };
    }
    if (!(await consumeActionTicket(db, run.organizationId, run.appId, 'comm.outbound', run.id))) {
      await refundEmailQuota(db, 'app', run.appId);
      await refundEmailQuota(db, 'org', run.organizationId);
      ctx.log(`hadron_send_email: skipped — no comm.outbound ticket (to ${masked})`);
      return {
        isError: true,
        error:
          'No outbound-communication ticket is available for this run. The email was skipped; ' +
          'an operator must grant comm.outbound tickets. Do not retry.',
      };
    }

    let result;
    try {
      result = await sendResendEmail(
        {
          to,
          subject,
          text,
          idempotencyKey: idempotencyKey(run.id, to, subject, text),
        },
        credentials,
      );
    } catch (err) {
      if (err instanceof GraphQLError && err.extensions?.code === 'RESEND_TOOL_ERROR') {
        const emailErrorCode =
          typeof err.extensions.emailErrorCode === 'string' ? err.extensions.emailErrorCode : undefined;
        ctx.log(`hadron_send_email: rejected${emailErrorCode ? ` (${emailErrorCode})` : ''} (to ${masked})`);
        return {
          isError: true,
          error: `The email was not sent: ${err.message} Do not retry with the same input.`,
          ...(emailErrorCode ? { emailErrorCode } : {}),
        };
      }
      throw err;
    }

    ctx.log(`hadron_send_email: sent to ${masked} (${text.length} chars, id ${result.id})`);
    return { sent: true, id: result.id, to: masked };
  },
};

export const EMAIL_TOOLS: readonly RunToolDef[] = [hadronSendEmail];
