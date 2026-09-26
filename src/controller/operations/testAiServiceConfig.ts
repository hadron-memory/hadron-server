/**
 * #1378 — test a SAVED AI config through the path a run uses (the server half
 * of hadron-portal#937).
 *
 * The portal's old Test called the PORTAL's own LLM client with a hardcoded
 * endpoint, and resolved App/Agent configs by NAME through the resolution
 * walk, so a green Test proved nothing about a run (org `hadronmemory.com`'s
 * `zai_glm53` passed while every run failed). This operation instead:
 *
 *   - takes the config by ID — the exact row being edited, never whichever
 *     same-named config the walk would pick;
 *   - makes ONE small call through `generateText`, the client runs use, so the
 *     endpoint, wire protocol and connect-time egress guard are the run's own;
 *   - keeps the key server-side: the stored key is decrypted in-process only,
 *     and provider error text is scrubbed of it before it is returned;
 *   - reports, field by field, whether the SAVED value or a caller OVERRIDE was
 *     used, so "it works" can never be misread as "the saved config works".
 *
 * Metering (Holger, 2026-09-26, recorded on #1378): every test that reaches
 * a provider is recorded (pre-call failures, NO_API_KEY and KEY_UNREADABLE,
 * make no call and record nothing) (`type: 'ai-config-test'`). A BYOK test uses the
 * owner's provider account; a caller-supplied override key is the caller's
 * own and never debits. The only PLATFORM-funded test is a platform admin
 * testing a HADRON_SERVER config (only they pass the gate for one, and an
 * org/App/Agent config with no key is NO_API_KEY, never the platform key): it
 * is recorded with keyOwnerType HADRON_SERVER, attributed to the caller's
 * active org when the request carries one (and counted against that org's
 * daily token quota, which must have headroom before the call, as a run's
 * launch gate requires), otherwise recorded as the platform's own usage. That
 * includes a HADRON_SERVER config with no stored key at a default host that
 * issued the server's own credential (the AWS chain for Bedrock, say): a run
 * uses that credential, so the test does too (`key: PLATFORM`). Small fixed
 * prompt, tight token cap, and the rate limit (charged only for calls that
 * reach a provider) bound every path.
 */

import { GraphQLError } from 'graphql';
import type { AiServiceConfig } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { aiConfigOwnerOf, requireAiConfigOwnerAdmin } from '../../api/graphql/schema/resolvers.helpers.js';
import { AiServiceConfigNotFoundError, validateProviderAndParams, type AiConfigOwnerType } from '../../lib/aiConfig.js';
import {
  effectiveApiStyle,
  effectiveEndpoint,
  validateApiStyle,
  usesProcessCredential,
  validateEndpoint,
  type AiApiStyle,
} from '../../lib/aiEndpoint.js';
import { generateText, LlmInvocationError, type LlmRequest, type LlmResult } from '../../lib/llm/index.js';
import { recordLlmUsage } from '../../lib/metering/index.js';
import { decryptToken, encryptToken } from '../../lib/tokenCrypto.js';
import { defaultQuotaLimit, hasQuotaHeadroom, recordQuotaUsage } from '../../jobs/appRuns.js';

export interface AiConfigTestOverride {
  provider?: string | null;
  model?: string | null;
  /** Omitted = the saved endpoint; null or '' = the provider default. */
  endpoint?: string | null;
  /** Omitted = the saved style; null = the provider default. */
  apiStyle?: AiApiStyle | null;
  /**
   * Tests with this key instead of the stored one. Never stored, never echoed.
   * Omitted = the stored key; null or '' = NO key, as updateAiServiceConfig
   * reads them (it clears the key), so an edit that removes the key tests as one.
   */
  apiKey?: string | null;
}

type Source = 'SAVED' | 'OVERRIDE';
/** PLATFORM: no stored key, and the server's own credential served the call, as it would a run's. */
type KeySource = Source | 'PLATFORM' | 'NONE';

export interface AiConfigTestResult {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string | null;
  apiStyle: AiApiStyle | null;
  used: { provider: Source; model: Source; endpoint: Source; apiStyle: Source; key: KeySource };
  latencyMs: number;
  reply: string | null;
  error: { code: string; message: string; transient: boolean } | null;
}

/** The fixed probe: a one-word answer, so a test costs a few dozen tokens. */
export const AI_CONFIG_TEST_REQUEST: LlmRequest = {
  prompt: 'Reply with the single word OK.',
  maxTokens: 16,
};

// ── Rate limit ───────────────────────────────────────────────────────────
// A test is a real provider call, so the button must not be a free relay.
// Per caller per config, in-process: the server runs as one instance today;
// a multi-instance deployment gets a per-instance allowance, still bounded.

export const AI_CONFIG_TEST_LIMIT = 5;
export const AI_CONFIG_TEST_WINDOW_MS = 60_000;
const recentTests = new Map<string, number[]>();

/** Past this many tracked pairs, every stale one is dropped (#1385 review). */
const LIMITER_SWEEP_AT = 1_000;

/** Admit one test for `key` at `now`; the seconds to wait when refused. Exported for tests. */
export function admitTest(key: string, now: number): number | null {
  if (recentTests.size >= LIMITER_SWEEP_AT) {
    for (const [k, times] of recentTests) {
      if (times.every((t) => now - t >= AI_CONFIG_TEST_WINDOW_MS)) recentTests.delete(k);
    }
  }
  const kept = (recentTests.get(key) ?? []).filter((t) => now - t < AI_CONFIG_TEST_WINDOW_MS);
  if (kept.length >= AI_CONFIG_TEST_LIMIT) {
    recentTests.set(key, kept);
    return Math.ceil((AI_CONFIG_TEST_WINDOW_MS - (now - kept[0])) / 1000);
  }
  kept.push(now);
  recentTests.set(key, kept);
  return null;
}

/** Test-only: forget every recorded test. */
export function resetAiConfigTestLimiter(): void {
  recentTests.clear();
}

/** Test-only: how many caller/config pairs the limiter is tracking. */
export function aiConfigTestLimiterSize(): number {
  return recentTests.size;
}

// ── Secrets never leave ──────────────────────────────────────────────────

/** Every secret string a key may appear as in provider error text. */
function secretsOf(rawKey: string | null): string[] {
  if (!rawKey) return [];
  const out = [rawKey];
  try {
    // bedrock stores a JSON triple; its parts can be echoed individually.
    const triple = JSON.parse(rawKey) as Record<string, unknown>;
    for (const v of [triple.accessKeyId, triple.secretAccessKey]) if (typeof v === 'string' && v) out.push(v);
  } catch {
    // not JSON — the whole key is the only secret
  }
  // Every non-empty secret, however short: the write paths accept short keys,
  // and "never echoed" has no length exception (#1385 review).
  return out.filter((s) => s.length > 0);
}

const MAX_ERROR_CHARS = 500;

function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS)}…` : out;
}

/**
 * The org a test's usage is attributed to: the config's own, else its owning
 * App's or Agent's, else the caller's active org IF the request carries one.
 * A platform admin's GraphQL request usually doesn't, and then a
 * HADRON_SERVER test is simply the platform's own usage (no org to charge).
 */
async function billableOrgOf(ctx: Context, row: AiServiceConfig): Promise<string | null> {
  if (row.organizationId) return row.organizationId;
  if (row.appId) {
    const app = await ctx.db.app.findUnique({ where: { id: row.appId }, select: { organizationId: true } });
    if (app?.organizationId) return app.organizationId;
  }
  if (row.agentId) {
    const agent = await ctx.db.agent.findUnique({ where: { id: row.agentId }, select: { organizationId: true } });
    if (agent?.organizationId) return agent.organizationId;
  }
  return ctx.organizationId ?? null;
}

export interface AiConfigTestDeps {
  generate: (resolved: Parameters<typeof generateText>[0], req: LlmRequest) => Promise<LlmResult>;
  now: () => number;
  /** The probe's hard deadline; an endpoint that never answers is a failed test, not a hung request. */
  timeoutMs: number;
}

/** Long enough for a slow model's first token, short enough for a button. */
export const AI_CONFIG_TEST_TIMEOUT_MS = 20_000;

const defaultDeps: AiConfigTestDeps = { generate: generateText, now: () => Date.now(), timeoutMs: AI_CONFIG_TEST_TIMEOUT_MS };

export async function testAiServiceConfig(
  ctx: Context,
  id: string,
  override: AiConfigTestOverride = {},
  deps: AiConfigTestDeps = defaultDeps,
): Promise<AiConfigTestResult> {
  const row = await ctx.db.aiServiceConfig.findUnique({ where: { id } });
  if (!row) throw new AiServiceConfigNotFoundError(id);
  const owner = aiConfigOwnerOf(row);
  // The same gate as updateAiServiceConfig: only the owner's admins test it.
  // A config the caller can't manage reads exactly like a missing one, so the
  // mutation is no oracle for which ids exist (#1385 review, Copilot).
  try {
    await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') throw new AiServiceConfigNotFoundError(id);
    throw e;
  }
  // Impersonation is a read-only support view (#876), and a test spends.
  if (ctx.impersonation || !ctx.userId) throw new Error('Forbidden');

  // The config under test: saved values, overridden field by field, and
  // validated exactly as a write would validate them.
  const provider = override.provider ?? row.provider;
  const model = override.model ?? row.model;
  // The RESULTING pair, as a save would judge it: a test that passes must be
  // an edit that can be saved (#1385 review, Codex).
  validateProviderAndParams(provider, row.params ?? null);
  const endpoint =
    override.endpoint === undefined ? row.endpoint : override.endpoint ? validateEndpoint(override.endpoint) : null;
  const apiStyle = override.apiStyle === undefined ? row.apiStyle : override.apiStyle;
  validateApiStyle(provider, apiStyle);
  const tested = { provider, endpoint, apiStyle };

  const overrideKey = override.apiKey || null;
  // Omitted keeps the stored key; an explicit null/'' clears it, exactly as
  // the write would (#1385 review), so it tests as "no key".
  const keyCleared = override.apiKey !== undefined && !override.apiKey;
  const keySource: KeySource = overrideKey
    ? 'OVERRIDE'
    : !keyCleared && row.apiKeyEncrypted
      ? 'SAVED'
      : // Only the platform's own config may run on the platform's credential
        // (Holger's metering ruling, above); modelFor decides the rest.
        owner.ownerType === 'HADRON_SERVER' && usesProcessCredential(tested)
        ? 'PLATFORM'
        : 'NONE';
  const used: AiConfigTestResult['used'] = {
    // Presence, not truthiness: an empty model is still what gets sent.
    provider: override.provider != null ? 'OVERRIDE' : 'SAVED',
    model: override.model != null ? 'OVERRIDE' : 'SAVED',
    endpoint: override.endpoint === undefined ? 'SAVED' : 'OVERRIDE',
    apiStyle: override.apiStyle === undefined ? 'SAVED' : 'OVERRIDE',
    key: keySource,
  };
  const base = {
    provider,
    model,
    endpoint: effectiveEndpoint(tested),
    apiStyle: effectiveApiStyle(tested),
    used,
  };
  if (keySource === 'NONE') {
    return {
      ...base,
      ok: false,
      latencyMs: 0,
      reply: null,
      error: {
        code: 'NO_API_KEY',
        message: keyCleared
          ? 'The edit clears this config\'s key; supply one to test with.'
          : 'This config has no stored key; supply one to test with.',
        transient: false,
      },
    };
  }

  // Decrypted only when it is the key being used: an override replaces it, and
  // a stale ciphertext must not block testing a good new key (#1385 review).
  let savedKey: string | null = null;
  if (keySource === 'SAVED' && row.apiKeyEncrypted) {
    try {
      savedKey = decryptToken(row.apiKeyEncrypted);
    } catch {
      // A stored key written under an older HADRON_ENCRYPTION_KEY, or
      // malformed: a failed test with a reason, not an internal error
      // (#1385 review, Codex). No provider call, so nothing is metered.
      return {
        ...base,
        ok: false,
        latencyMs: 0,
        reply: null,
        error: {
          code: 'KEY_UNREADABLE',
          message: 'The stored key cannot be decrypted on this server; re-enter it to test and save.',
          transient: false,
        },
      };
    }
  }
  const secrets = [...secretsOf(overrideKey), ...secretsOf(savedKey)];
  const resolved = {
    config: {
      ...row,
      provider,
      model,
      endpoint,
      apiStyle,
      // PLATFORM runs keyless even when the edit is what cleared the key.
      apiKeyEncrypted: overrideKey ? encryptToken(overrideKey) : keySource === 'SAVED' ? row.apiKeyEncrypted : null,
    },
    ownerType: owner.ownerType,
  };

  // An override key is the caller's own; a platform credential, stored or the
  // process's, is the platform's.
  const keyOwnerType: AiConfigOwnerType | null = overrideKey ? null : keySource === 'PLATFORM' ? 'HADRON_SERVER' : owner.ownerType;
  const organizationId = await billableOrgOf(ctx, row);
  // A platform-funded probe needs the org's token headroom first, as a run's
  // launch gate does: recordQuotaUsage records overage, it never refuses
  // (#1385 review, Codex). No call, so nothing is metered.
  if (
    keyOwnerType === 'HADRON_SERVER' &&
    organizationId &&
    !(await hasQuotaHeadroom(ctx.db, 'org', organizationId, 'llm.tokens', defaultQuotaLimit('org', 'llm.tokens')))
  ) {
    return {
      ...base,
      ok: false,
      latencyMs: 0,
      reply: null,
      error: {
        code: 'QUOTA_EXCEEDED',
        message: "The organization's daily platform token allowance is used up; a platform-funded test would exceed it.",
        transient: true,
      },
    };
  }

  // Charged here, just before the provider call: a test refused locally (no
  // key, an unreadable key, an invalid override) costs nobody anything, so it
  // must not use up the caller's allowance either (#1385 review, Codex).
  const retryAfter = admitTest(`${ctx.userId}:${row.id}`, deps.now());
  if (retryAfter != null) {
    throw new GraphQLError(`Too many tests of this config; try again in ${retryAfter}s.`, {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: retryAfter },
    });
  }

  const started = deps.now();
  let out: LlmResult | null = null;
  let error: AiConfigTestResult['error'] = null;
  try {
    out = await deps.generate(resolved, { ...AI_CONFIG_TEST_REQUEST, timeoutMs: deps.timeoutMs });
  } catch (e) {
    error = {
      code: 'LLM_CALL_FAILED',
      message: scrub(String((e as Error)?.message ?? e), secrets),
      transient: e instanceof LlmInvocationError ? e.transient : false,
    };
  }
  const latencyMs = Math.max(0, deps.now() - started);

  // Every test is recorded; a failed call is recorded at zero tokens so the
  // attempt itself is on the ledger.
  const tokensIn = out?.tokensIn ?? 0;
  const tokensOut = out?.tokensOut ?? 0;
  await recordLlmUsage(ctx.db, {
    type: 'ai-config-test',
    userId: ctx.userId,
    organizationId,
    provider,
    model,
    tokensIn,
    tokensOut,
    keyOwnerType,
    createdBy: ctx.userId,
  });
  // Platform-funded tests count against the org's daily token allowance.
  if (keyOwnerType === 'HADRON_SERVER' && organizationId && tokensIn + tokensOut > 0) {
    await recordQuotaUsage(ctx.db, 'org', organizationId, 'llm.tokens', defaultQuotaLimit('org', 'llm.tokens'), tokensIn + tokensOut);
  }

  return {
    ...base,
    ok: out != null,
    latencyMs,
    reply: out ? scrub(out.text, secrets).slice(0, 200) : null,
    error,
  };
}
