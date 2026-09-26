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
 * Metering (Holger, 2026-09-26, recorded on #1378): every test is recorded
 * (`type: 'ai-config-test'`); a test on the platform's key (a HADRON_SERVER
 * config, no override key) is platform-funded and counts against the org's
 * daily token quota and the existing debit rule; a BYOK test uses the owner's
 * provider account; a caller-supplied override key is the caller's own and
 * never debits. Small fixed prompt, tight token cap, rate-limited.
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
  validateEndpoint,
  type AiApiStyle,
} from '../../lib/aiEndpoint.js';
import { generateText, LlmInvocationError, type LlmRequest, type LlmResult } from '../../lib/llm/index.js';
import { recordLlmUsage } from '../../lib/metering/index.js';
import { decryptToken, encryptToken } from '../../lib/tokenCrypto.js';
import { defaultQuotaLimit, recordQuotaUsage } from '../../jobs/appRuns.js';

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

export interface AiConfigTestResult {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string | null;
  apiStyle: AiApiStyle | null;
  used: { provider: Source; model: Source; endpoint: Source; apiStyle: Source; key: Source | 'NONE' };
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

/** The org a test's usage is attributed to: the config's own, else its owner's, else the caller's active one. */
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
}

const defaultDeps: AiConfigTestDeps = { generate: generateText, now: () => Date.now() };

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
  await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
  // Impersonation is a read-only support view (#876), and a test spends.
  if (ctx.impersonation || !ctx.userId) throw new Error('Forbidden');

  const retryAfter = admitTest(`${ctx.userId}:${row.id}`, deps.now());
  if (retryAfter != null) {
    throw new GraphQLError(`Too many tests of this config; try again in ${retryAfter}s.`, {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: retryAfter },
    });
  }

  // The config under test: saved values, overridden field by field, and
  // validated exactly as a write would validate them.
  const provider = override.provider ?? row.provider;
  const model = override.model ?? row.model;
  validateProviderAndParams(provider, null);
  const endpoint =
    override.endpoint === undefined ? row.endpoint : override.endpoint ? validateEndpoint(override.endpoint) : null;
  const apiStyle = override.apiStyle === undefined ? row.apiStyle : override.apiStyle;
  validateApiStyle(provider, apiStyle);
  const tested = { provider, endpoint, apiStyle };

  const overrideKey = override.apiKey || null;
  // Omitted keeps the stored key; an explicit null/'' clears it, exactly as
  // the write would (#1385 review), so it tests as "no key".
  const keyCleared = override.apiKey !== undefined && !override.apiKey;
  const keySource: Source | 'NONE' = overrideKey ? 'OVERRIDE' : !keyCleared && row.apiKeyEncrypted ? 'SAVED' : 'NONE';
  const used: AiConfigTestResult['used'] = {
    provider: override.provider ? 'OVERRIDE' : 'SAVED',
    model: override.model ? 'OVERRIDE' : 'SAVED',
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

  const savedKey = row.apiKeyEncrypted ? decryptToken(row.apiKeyEncrypted) : null;
  const secrets = [...secretsOf(overrideKey), ...secretsOf(savedKey)];
  const resolved = {
    config: {
      ...row,
      provider,
      model,
      endpoint,
      apiStyle,
      apiKeyEncrypted: overrideKey ? encryptToken(overrideKey) : row.apiKeyEncrypted,
    },
    ownerType: owner.ownerType,
  };

  const started = deps.now();
  let out: LlmResult | null = null;
  let error: AiConfigTestResult['error'] = null;
  try {
    out = await deps.generate(resolved, AI_CONFIG_TEST_REQUEST);
  } catch (e) {
    error = {
      code: 'LLM_CALL_FAILED',
      message: scrub(String((e as Error)?.message ?? e), secrets),
      transient: e instanceof LlmInvocationError ? e.transient : false,
    };
  }
  const latencyMs = Math.max(0, deps.now() - started);

  // Every test is recorded; a failed call is recorded at zero tokens so the
  // attempt itself is on the ledger. An override key is the caller's own.
  const keyOwnerType: AiConfigOwnerType | null = overrideKey ? null : owner.ownerType;
  const organizationId = await billableOrgOf(ctx, row);
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
