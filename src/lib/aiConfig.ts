/**
 * AI service config registry (spec 036).
 *
 * One AiServiceConfig row = one named (provider, model, key, params)
 * tuple owned by exactly one of HadronServer / Organization / App /
 * Agent. Resolution walks App -> Agent -> Org (of the App, else of the
 * Agent) -> HadronServer and returns the first ENABLED config with the
 * requested name; the well-known fallback name is 'default'.
 *
 * Consumers (chat sessions, curation jobs, future webhooks/scheduled
 * tasks) reference configs by NAME only — they never own configs.
 */

import { z } from 'zod';

import type { AiServiceConfig, Prisma, PrismaClient } from '../generated/prisma/index.js';
import { encryptToken } from './tokenCrypto.js';

// ── Typed errors (Constitution S2 — resolver layer maps name → extensions.code) ──

/**
 * Lock an AI config's row for the rest of the transaction and read it as it
 * is NOW (#1380 review). Write-time invariants (the provider/style pair, a
 * provider change clearing a stale endpoint/style) are judged on this row, so
 * two concurrent updates can't each pass on the old row and together write a
 * pair neither judged.
 */
export async function lockAiServiceConfig(tx: Prisma.TransactionClient, id: string): Promise<AiServiceConfig | null> {
  await tx.$queryRaw`SELECT 1 FROM "ai_service_configs" WHERE "id" = ${id} FOR UPDATE`;
  return tx.aiServiceConfig.findUnique({ where: { id } });
}

export class AiServiceConfigNotFoundError extends Error {
  constructor(public ref: string) {
    super(`AI service config not found: ${ref}`);
    this.name = 'AiServiceConfigNotFoundError';
  }
}

export class DuplicateAiServiceConfigNameError extends Error {
  constructor(public configName: string) {
    super(
      `An AI service config named '${configName}' already exists on this owner. ` +
        `Config names must be unique per owner — pick a different name or update the existing config.`,
    );
    this.name = 'DuplicateAiServiceConfigNameError';
  }
}

export class UnknownAiProviderError extends Error {
  constructor(provider: string, detail?: string) {
    super(
      detail ??
        `Unknown AI provider '${provider}'. Supported providers: ${KNOWN_AI_PROVIDERS.join(', ')}.`,
    );
    this.name = 'UnknownAiProviderError';
  }
}

export class NoAiConfigAvailableError extends Error {
  constructor(configName: string, contextDescription: string) {
    super(
      `No AI configuration available: neither '${configName}'` +
        (configName === DEFAULT_AI_CONFIG_NAME ? '' : ` nor '${DEFAULT_AI_CONFIG_NAME}'`) +
        ` resolved for ${contextDescription}. Define a config at the App, Agent, ` +
        `Organization, or server level.`,
    );
    this.name = 'NoAiConfigAvailableError';
  }
}

// ── Provider registry + validation ──────────────────────────────────────

export const KNOWN_AI_PROVIDERS = ['anthropic', 'openai', 'glm', 'bedrock'] as const;
export type AiProvider = (typeof KNOWN_AI_PROVIDERS)[number];

export const DEFAULT_AI_CONFIG_NAME = 'default';

/** Lower-case canonical; same charset as URN locs minus colons. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateAiConfigName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw new AiConfigValidationError(
      `Invalid AI config name '${name}': use 1-64 lower-case letters, digits, '-' or '_', starting with a letter or digit.`,
    );
  }
  return trimmed;
}

export class AiConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigValidationError';
  }
}

// Provider-specific knobs. Passthrough-permissive: unknown keys are kept
// verbatim so new provider features don't require a server release; the
// well-known keys are type-checked.
const baseParams = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .passthrough();

const PROVIDER_PARAMS: Record<AiProvider, z.ZodType> = {
  anthropic: baseParams.extend({
    thinking: z.boolean().optional(),
    effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  }),
  openai: baseParams.extend({
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  }),
  glm: baseParams,
  // Bedrock credentials travel JSON-encoded in the apiKey field (portal
  // convention, finding llm-provider-config-surfaces); params stay generic.
  bedrock: baseParams,
};

export function validateProviderAndParams(provider: string, params: unknown): void {
  const schema = PROVIDER_PARAMS[provider as AiProvider];
  if (!schema) throw new UnknownAiProviderError(provider);
  if (params == null) return;
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new UnknownAiProviderError(
      provider,
      `Invalid params for provider '${provider}': ${result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
}

// ── Key handling ─────────────────────────────────────────────────────────

export function apiKeyPreviewOf(rawKey: string): string {
  return rawKey.length >= 4 ? '…' + rawKey.slice(-4) : '…';
}

/**
 * Shared write semantics for the apiKey input field:
 *   undefined    → keep stored key (no change)
 *   ''           → clear the stored key
 *   non-empty    → encrypt + recompute preview
 * Matches the legacy updateAgentAIConfig behavior.
 */
export function apiKeyWriteFields(
  apiKey: string | null | undefined,
): { apiKeyEncrypted: string | null; apiKeyPreview: string | null } | Record<string, never> {
  if (apiKey === undefined) return {};
  if (apiKey === null || apiKey === '') return { apiKeyEncrypted: null, apiKeyPreview: null };
  return { apiKeyEncrypted: encryptToken(apiKey), apiKeyPreview: apiKeyPreviewOf(apiKey) };
}

// ── Resolution walk ──────────────────────────────────────────────────────

export type AiConfigOwnerType = 'HADRON_SERVER' | 'ORGANIZATION' | 'APP' | 'AGENT';

export interface AiConfigContext {
  /** Installation context; its org is the Org level of the walk. */
  appId?: string | null;
  /** Design-time context; supplies the Org level when no App is given. */
  agentId?: string | null;
  /** Explicit org context (e.g. platform jobs scoped to an org). */
  organizationId?: string | null;
}

export interface ResolvedAiConfig {
  config: AiServiceConfig;
  ownerType: AiConfigOwnerType;
}

/**
 * Walk App -> Agent -> Org -> HadronServer for the first ENABLED config
 * with `name`. Levels absent from the context are skipped (a platform
 * job with no App/Agent/org resolves against the host only). Returns
 * null when no level matches.
 */
export async function resolveAiConfig(
  db: PrismaClient,
  name: string,
  ctx: AiConfigContext,
): Promise<ResolvedAiConfig | null> {
  const { appId, agentId } = ctx;
  let organizationId = ctx.organizationId ?? null;

  // Each owner level is one query: the level's matching config and (for
  // App/Agent) its organizationId come back together, so a miss costs no
  // extra roundtrip for the org lookup (PR #262 review).
  if (appId) {
    const app = await db.app.findUnique({
      where: { id: appId },
      include: { aiServiceConfigs: { where: { name, enabled: true }, take: 1 } },
    });
    const config = app?.aiServiceConfigs[0];
    if (config) return { config, ownerType: 'APP' };
    if (!organizationId) organizationId = app?.organizationId ?? null;
  }

  if (agentId) {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      include: { aiServiceConfigs: { where: { name, enabled: true }, take: 1 } },
    });
    const config = agent?.aiServiceConfigs[0];
    if (config) return { config, ownerType: 'AGENT' };
    if (!organizationId) organizationId = agent?.organizationId ?? null;
  }

  if (organizationId) {
    const config = await db.aiServiceConfig.findFirst({
      where: { organizationId, name, enabled: true },
    });
    if (config) return { config, ownerType: 'ORGANIZATION' };
  }

  const config = await db.aiServiceConfig.findFirst({
    where: { hadronServerId: { not: null }, name, enabled: true },
    orderBy: { createdAt: 'asc' },
  });
  if (config) return { config, ownerType: 'HADRON_SERVER' };

  return null;
}

export async function resolveDefaultAiConfig(
  db: PrismaClient,
  ctx: AiConfigContext,
): Promise<ResolvedAiConfig | null> {
  return resolveAiConfig(db, DEFAULT_AI_CONFIG_NAME, ctx);
}

/**
 * Collect every config RESOLVABLE in a context — the plural, list-all-names
 * analogue of resolveAiConfig (which resolves ONE name). Walks the same
 * App -> Agent -> Org (of the App, else of the Agent) -> HadronServer order,
 * gathering all ENABLED configs and deduping by name with the INNERMOST owner
 * winning, so each name appears once as the row resolveAiConfig would return
 * for it. Absent levels are skipped; disabled configs are skipped.
 *
 * Only the Agent named in `ctx` contributes — sibling Agents installed in the
 * same App are never consulted (resolution always runs for one App+Agent
 * pair). Powers the chatbot UI's "which config can I pick" list; callers map
 * the rows through the masked view (never key material).
 */
export async function resolveAiConfigs(
  db: PrismaClient,
  ctx: AiConfigContext,
): Promise<ResolvedAiConfig[]> {
  const { appId, agentId } = ctx;
  let organizationId = ctx.organizationId ?? null;

  // Inner -> outer walk; keep the FIRST config seen per name so the innermost
  // owner wins, mirroring resolveAiConfig's single-name precedence.
  const byName = new Map<string, ResolvedAiConfig>();
  const collect = (configs: AiServiceConfig[], ownerType: AiConfigOwnerType): void => {
    for (const config of configs) {
      if (!byName.has(config.name)) byName.set(config.name, { config, ownerType });
    }
  };

  if (appId) {
    const app = await db.app.findUnique({
      where: { id: appId },
      include: { aiServiceConfigs: { where: { enabled: true } } },
    });
    if (app) collect(app.aiServiceConfigs, 'APP');
    if (!organizationId) organizationId = app?.organizationId ?? null;
  }

  if (agentId) {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      include: { aiServiceConfigs: { where: { enabled: true } } },
    });
    if (agent) collect(agent.aiServiceConfigs, 'AGENT');
    if (!organizationId) organizationId = agent?.organizationId ?? null;
  }

  if (organizationId) {
    collect(
      await db.aiServiceConfig.findMany({ where: { organizationId, enabled: true } }),
      'ORGANIZATION',
    );
  }

  collect(
    await db.aiServiceConfig.findMany({
      where: { hadronServerId: { not: null }, enabled: true },
      orderBy: { createdAt: 'asc' },
    }),
    'HADRON_SERVER',
  );

  return [...byName.values()].sort((a, b) => a.config.name.localeCompare(b.config.name));
}

/**
 * Consumer-facing semantics (spec 036 FR-007): explicit name miss falls
 * back to 'default'; a 'default' miss throws NoAiConfigAvailableError.
 */
export async function resolveAiConfigWithFallback(
  db: PrismaClient,
  name: string | null | undefined,
  ctx: AiConfigContext,
): Promise<ResolvedAiConfig> {
  const requested = name ?? DEFAULT_AI_CONFIG_NAME;
  const hit = await resolveAiConfig(db, requested, ctx);
  if (hit) return hit;
  if (requested !== DEFAULT_AI_CONFIG_NAME) {
    const fallback = await resolveDefaultAiConfig(db, ctx);
    if (fallback) return fallback;
  }
  throw new NoAiConfigAvailableError(requested, describeContext(ctx));
}

function describeContext(ctx: AiConfigContext): string {
  const parts: string[] = [];
  if (ctx.appId) parts.push(`app ${ctx.appId}`);
  if (ctx.agentId) parts.push(`agent ${ctx.agentId}`);
  if (ctx.organizationId) parts.push(`organization ${ctx.organizationId}`);
  return parts.length ? `context (${parts.join(', ')})` : 'the server context';
}
