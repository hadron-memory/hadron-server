/**
 * Webfetch polling run tools (#667). Core owns authorization, credential
 * sourcing, and the immutable origin-run routing binding; hadrontool-webfetch
 * owns job state, scheduling, condition evaluation, and delivery retries.
 */
import {
  cancelPoll,
  createPoll,
  listPolls,
  type CreatePollInput,
  type WebPollCondition,
} from '../../webfetchClient.js';
import { loadWebFetchAuthSecret } from '../secrets.js';
import { isSecretOwnerType, SECRET_OWNER_TYPES, SECRET_SCOPE_ORDER, type SecretOwnerType } from '../../secrets.js';
import { redactUrl } from '../../webUrl.js';
import { cancelOrgWebPoll } from '../../webPolls.js';
import type { RunToolDef } from './types.js';
import { coerceHeaders } from './webTools.js';

const CONTENT_KINDS = ['auto', 'html', 'json'] as const;
const MODES = ['any', 'all'] as const;
const FIRE_POLICIES = ['once', 'every_change', 'cooldown'] as const;

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`web_poll_start: "${field}" must be a positive integer.`);
  }
  return value;
}

function optionalEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new Error(`web_poll_start: "${field}" must be one of ${values.join(', ')}.`);
  }
  return value as T[number];
}

function pollConditions(value: unknown): WebPollCondition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('web_poll_start: "conditions" must be a non-empty array.');
  }
  if (value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('web_poll_start: every condition must be an object.');
  }
  return value as WebPollCondition[];
}

export const webPollStart: RunToolDef = {
  name: 'web_poll_start',
  policyAction: 'tool.web_poll',
  description:
    'Start a durable GET-only watch on an http(s) URL. The sidecar evaluates the supplied HTML/JSON ' +
    'conditions until they trigger or the mandatory TTL expires. Use credentialName to inject a ' +
    'webfetch-auth secret whose urlPrefix covers this URL — it resolves server-side ' +
    `(${SECRET_SCOPE_ORDER.join(', then ')} cascade) and the value never enters your context; ` +
    'never put secrets in headers or arguments.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Frozen absolute URL to poll.' },
      contentKind: { type: 'string', enum: [...CONTENT_KINDS] },
      conditions: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'object' },
        description: 'Sidecar condition objects; each must have a caller-chosen id.',
      },
      mode: { type: 'string', enum: [...MODES], description: 'Match any (default) or all conditions.' },
      intervalSeconds: { type: 'number', description: 'Poll interval; sidecar enforces its configured floor.' },
      ttlSeconds: { type: 'number', description: 'Mandatory lifetime; sidecar enforces its configured ceiling.' },
      firePolicy: { type: 'string', enum: [...FIRE_POLICIES] },
      cooldownSeconds: { type: 'number' },
      credentialName: {
        type: 'string',
        description:
          'Optional name of a webfetch-auth secret (hadron secret store). Resolved and injected ' +
          'server-side; the value is never returned to the model.',
      },
      credentialScope: {
        type: 'string',
        // #1564: derived from the secret store's own owner list, so the
        // advertised scopes can never drift from what it accepts again (the
        // app/memory owners were removed by #696 and kept being offered here).
        enum: [...SECRET_OWNER_TYPES],
        description:
          'Optional: resolve credentialName at exactly this scope instead of the cascade ' +
          `(user, then org). One of: ${SECRET_OWNER_TYPES.join(', ')}.`,
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional non-secret request headers. Never pass authorization/cookie material here.',
      },
    },
    required: ['url', 'conditions', 'intervalSeconds', 'ttlSeconds'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url) throw new Error('web_poll_start: "url" is required.');
    const conditions = pollConditions(args.conditions);
    const contentKind = optionalEnum(args.contentKind, CONTENT_KINDS, 'contentKind');
    const mode = optionalEnum(args.mode, MODES, 'mode');
    const firePolicy = optionalEnum(args.firePolicy, FIRE_POLICIES, 'firePolicy');
    const intervalSeconds = requiredPositiveInteger(args.intervalSeconds, 'intervalSeconds');
    const ttlSeconds = requiredPositiveInteger(args.ttlSeconds, 'ttlSeconds');
    const cooldownSeconds =
      args.cooldownSeconds == null
        ? undefined
        : requiredPositiveInteger(args.cooldownSeconds, 'cooldownSeconds');
    const headers = coerceHeaders(args.headers);
    const credentialName =
      typeof args.credentialName === 'string' && args.credentialName.length > 0
        ? args.credentialName
        : undefined;
    let credentialScope: SecretOwnerType | undefined;
    if (args.credentialScope != null) {
      if (!isSecretOwnerType(args.credentialScope)) {
        throw new Error(`web_poll_start: "credentialScope" must be one of ${SECRET_OWNER_TYPES.join(', ')}.`);
      }
      credentialScope = args.credentialScope;
    }
    // INJECT path (#677): the secret resolves server-side and goes straight
    // to the sidecar — a poll fetches untrusted external content, so the
    // value must never be readable from model context.
    const credential = credentialName
      ? await loadWebFetchAuthSecret(ctx, credentialName, credentialScope, url)
      : undefined;

    const input: CreatePollInput = {
      url,
      conditions,
      intervalSeconds,
      ttlSeconds,
      orgId: ctx.run.organizationId,
      appId: ctx.run.appId,
      ...(contentKind ? { contentKind } : {}),
      ...(mode ? { mode } : {}),
      ...(firePolicy ? { firePolicy } : {}),
      ...(cooldownSeconds != null ? { cooldownSeconds } : {}),
      ...(headers ? { headers } : {}),
      // The sidecar's audit-provenance field keeps its legacy wire name
      // (renaming is a hadrontool-webfetch follow-up); it now carries the
      // resolved Secret row reference, not a node URN.
      ...(credential ? { credentialsNodeUrn: `secret:${credential.secretId}` } : {}),
      ...(credential ? { auth: credential.auth, urlPrefix: credential.urlPrefix } : {}),
    };
    const created = await createPoll(input);
    if (!created || typeof created.jobId !== 'string' || typeof created.expiresAt !== 'string') {
      throw new Error('web_poll_start: sidecar returned an invalid creation response.');
    }

    const ledgerUrl = redactUrl(url);
    try {
      await ctx.db.webFetchPollBinding.create({
        data: {
          jobId: created.jobId,
          sourceRunId: ctx.run.id,
          organizationId: ctx.run.organizationId,
          appId: ctx.run.appId,
          agentId: ctx.run.agentId,
          userId: ctx.run.userId,
          entryNodeUrn: ctx.run.entryNodeUrn,
          policy: ctx.run.policy ?? undefined,
          credentialSecretId: credential?.secretId,
          url: ledgerUrl,
        },
      });
    } catch (err) {
      // A sidecar job without its core routing binding could never deliver to
      // the right agent. Compensate best-effort, then fail the tool call loud.
      await cancelPoll(created.jobId).catch((cancelErr) => {
        console.error(`[web-poll] failed to compensate unbound job ${created.jobId}:`, cancelErr);
      });
      throw err;
    }
    ctx.log(
      `web_poll_start ${JSON.stringify({
        jobId: created.jobId,
        ...(credentialName ? { credentialName } : {}),
        url: ledgerUrl,
      })}`,
    );
    return { jobId: created.jobId, expiresAt: created.expiresAt };
  },
};

export const webPollCancel: RunToolDef = {
  name: 'web_poll_cancel',
  policyAction: 'tool.web_poll',
  description: 'Cancel an active web poll in this organization by jobId.',
  inputSchema: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const jobId = typeof args.jobId === 'string' ? args.jobId : '';
    if (!jobId) throw new Error('web_poll_cancel: "jobId" is required.');
    const result = await cancelOrgWebPoll(ctx.db, ctx.run.organizationId, jobId);
    if (!result) throw new Error('web_poll_cancel: job not found in this organization.');
    if (result.alreadyCancelled) return { jobId, cancelled: true, alreadyCancelled: true };
    ctx.log(`web_poll_cancel ${JSON.stringify({ jobId })}`);
    return { jobId, cancelled: true };
  },
};

export const webPollList: RunToolDef = {
  name: 'web_poll_list',
  policyAction: 'tool.web_poll',
  description:
    'List this organization\'s active web polls with status and counters only. Credential material is never returned.',
  inputSchema: { type: 'object', properties: {} },
  cost: 0,
  execute: async (ctx) => listPolls(ctx.run.organizationId),
};

export const WEB_POLL_TOOLS: readonly RunToolDef[] = [webPollStart, webPollCancel, webPollList];
