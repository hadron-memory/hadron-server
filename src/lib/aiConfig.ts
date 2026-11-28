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
import { creditGateActive } from './metering/switches.js';
import { encryptToken } from './tokenCrypto.js';
import { chatToolChoiceFor, type ChatToolChoice } from './llm/chatToolChoice.js';
import { type OwnedRow, type OwnerRef, ownerOfWork } from './owner.js';

// ── Typed errors (Constitution S2 — resolver layer maps name → extensions.code) ──

/**
 * Lock an AI config's row for the rest of the transaction and read it as it
 * is NOW (#1380 / #1389 review). Write-time invariants (the provider/style
 * pair, the endpoint and key a config needs, a provider change clearing a
 * stale endpoint/style) are judged on this row, so a concurrent edit can't
 * slip between the check and the write.
 */
export async function lockAiServiceConfig(tx: Prisma.TransactionClient, id: string): Promise<AiServiceConfig | null> {
  await tx.$queryRaw`SELECT 1 FROM "ai_service_configs" WHERE "id" = ${id} FOR UPDATE`;
  return tx.aiServiceConfig.findUnique({ where: { id } });
}

export class AiServiceConfigNotFoundError extends Error {
  constructor(public ref: string) {
    super('AI service config not found');
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

export const KNOWN_AI_PROVIDERS = ['anthropic', 'openai', 'glm', 'kimi', 'bedrock', 'openai-compatible'] as const;
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
  // #4170: Moonshot; own key only, same params as glm (no toolCalling opt-in).
  kimi: baseParams,
  // Bedrock credentials travel JSON-encoded in the apiKey field (portal
  // convention, finding llm-provider-config-surfaces); params stay generic.
  bedrock: baseParams,
  // #1373 (Holger, 2026-09-26): any host speaking an OpenAI wire protocol —
  // vLLM, Ollama, LM Studio, OpenRouter, Together, Groq, DeepSeek, … Its
  // endpoint is REQUIRED (there is no default host). `toolCalling: true` opts
  // the config into the run tool loop, which is otherwise refused: an unknown
  // host is not assumed to support function calling.
  'openai-compatible': baseParams.extend({
    toolCalling: z.boolean().optional(),
  }),
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

/**
 * #1417 (Holger, 2026-09-30) — the provider-specific range a knob's value
 * must fall in, where it is KNOWN. Only ranges the installed provider
 * adapter itself enforces are listed: @ai-sdk/anthropic and
 * @ai-sdk/amazon-bedrock clamp temperature to [0, 1] and say so. Every other
 * provider keeps the generic schema range: "we can't validate all", and an
 * OpenAI-compatible host's range is unknowable here.
 */
const PROVIDER_PARAM_RANGES: Partial<Record<AiProvider, Record<string, { max: number }>>> = {
  anthropic: { temperature: { max: 1 } },
  bedrock: { temperature: { max: 1 } },
};

/**
 * Refuse a WRITTEN knob value outside its provider's known range.
 *
 * Deliberately separate from `validateProviderAndParams`, which also judges
 * STORED rows (a saved-config Test, an update that leaves params alone): a
 * row saved before this rule stays valid, runs, and is reported ADJUSTED by
 * the knob report, rather than breaking. Call it only where params are being
 * written or edited: create, an update that sets params or changes the
 * provider, and a Test override doing either.
 */
export function validateParamRanges(provider: string, params: unknown): void {
  const ranges = PROVIDER_PARAM_RANGES[provider as AiProvider];
  if (!ranges || !params || typeof params !== 'object') return;
  for (const [param, { max }] of Object.entries(ranges)) {
    const value = (params as Record<string, unknown>)[param];
    if (typeof value === 'number' && value > max) {
      throw new UnknownAiProviderError(
        provider,
        `Invalid params for provider '${provider}': ${param}: must be at most ${max} for this provider (got ${value}).`,
      );
    }
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
  /** Installation context; its owner is the tenant of the walk (an organization's App: that organization's level; a person's App: neither the organization nor the platform level). */
  appId?: string | null;
  /** Design-time context; its own configurations answer, and its owner is the tenant when no App is given. */
  agentId?: string | null;
  /** Explicit org context (e.g. platform jobs scoped to an org); always the App's own organization. Never overrides a person's App. */
  organizationId?: string | null;
}

export interface ResolvedAiConfig {
  config: AiServiceConfig;
  ownerType: AiConfigOwnerType;
  /**
   * #4042: the chat turn's tool-choice decision for this config, from the one predicate
   * (`chatToolChoiceFor`, cor:dmo:050:10). Non-null on every resolve path, whatever level of the walk wins.
   */
  toolChoice: ChatToolChoice;
}

/** The one place a walk result is built, so no resolve path can omit the decision (#4042). */
function resolved(config: AiServiceConfig, ownerType: AiConfigOwnerType): ResolvedAiConfig {
  return { config, ownerType, toolChoice: chatToolChoiceFor(config.provider, config.model) };
}

/**
 * #5075 (cor:dmo:050:10, cor:dmo:170:05): the tenant of an AI-configuration context, decided ONCE for the walk, the list
 * walk, the decrypting query and the chat tool-choice read. In order:
 *   1. an App that exists and a person owns: that person, and nothing else is consulted;
 *   2. else an explicit organization (jobs scoped to one; it is always the App's own organization): that organization;
 *   3. else the owner of the work (the App's owner, else the Agent's);
 *   4. else UNOWNED when an App or Agent row exists but names no owner (the platform level stays closed), else the
 *      server's own context (no App or Agent row: a platform job, or an id with no row, as before).
 * An organization's App running another party's Agent stays the organization's tenant, so every organization context
 * answers as before.
 */
export type AiConfigTenant = OwnerRef | { server: true } | { unowned: true };

export function aiConfigTenantFor(input: {
  app: OwnedRow | null;
  agent: OwnedRow | null;
  organizationId: string | null;
}): AiConfigTenant {
  if (input.app?.ownerUserId != null) return { userId: input.app.ownerUserId };
  if (input.organizationId) return { organizationId: input.organizationId };
  const owner = ownerOfWork(input.app, input.agent);
  if (owner) return owner;
  // No owner. A row that exists but names no owner (an impossible row under the owner XOR invariant) is UNOWNED and
  // closes the platform level; a context with no App or Agent row at all (a platform job, or an id with no row) is the
  // server's own context.
  return input.app || input.agent ? { unowned: true } : { server: true };
}

/**
 * Whether the walk may consult the HadronServer level: the platform's configuration answers for a server context and for
 * an organization, never for an unowned row, and for a person only while the deployment charges for and gates platform-key
 * spend (#5025, Billing A8; cor:dmo:050:10): `creditGateActive()` is the one predicate, read per call, so every such use is
 * debited to the person (cor:dmo:170:05) and checked against the person's balance (cor:acl:050:05).
 */
function platformLevelOpen(tenant: AiConfigTenant): boolean {
  return 'server' in tenant || 'organizationId' in tenant || ('userId' in tenant && creditGateActive());
}

/**
 * Walk App -> Agent -> Org -> HadronServer for the first ENABLED config
 * with `name`. The App's and the Agent's own configurations are always consulted; the organization level and the platform
 * level only for the tenant they belong to ({@link aiConfigTenantFor}, {@link platformLevelOpen}): a person's App (or a
 * person's Agent) sees neither. Levels absent from the context are skipped (a platform job with no App/Agent/org resolves
 * against the host only). Returns null when no level matches.
 */
export async function resolveAiConfig(
  db: PrismaClient,
  name: string,
  ctx: AiConfigContext,
): Promise<ResolvedAiConfig | null> {
  const { appId, agentId } = ctx;
  let app: OwnedRow | null = null;
  let agent: OwnedRow | null = null;

  // Each owner level is one query: the level's matching config and (for
  // App/Agent) its owner columns come back together, so a miss costs no
  // extra roundtrip for the org lookup (PR #262 review).
  if (appId) {
    const row = await db.app.findUnique({
      where: { id: appId },
      include: { aiServiceConfigs: { where: { name, enabled: true }, take: 1 } },
    });
    const config = row?.aiServiceConfigs[0];
    if (config) return resolved(config, 'APP');
    app = row;
  }

  if (agentId) {
    const row = await db.agent.findUnique({
      where: { id: agentId },
      include: { aiServiceConfigs: { where: { name, enabled: true }, take: 1 } },
    });
    const config = row?.aiServiceConfigs[0];
    if (config) return resolved(config, 'AGENT');
    agent = row;
  }

  const tenant = aiConfigTenantFor({ app, agent, organizationId: ctx.organizationId ?? null });

  if ('organizationId' in tenant) {
    const config = await db.aiServiceConfig.findFirst({
      where: { organizationId: tenant.organizationId, name, enabled: true },
    });
    if (config) return resolved(config, 'ORGANIZATION');
  }

  if (!platformLevelOpen(tenant)) return null;

  const config = await db.aiServiceConfig.findFirst({
    where: { hadronServerId: { not: null }, name, enabled: true },
    orderBy: { createdAt: 'asc' },
  });
  if (config) return resolved(config, 'HADRON_SERVER');

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
 * App -> Agent -> Org (of the tenant, {@link aiConfigTenantFor}) -> HadronServer order,
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
  let app: OwnedRow | null = null;
  let agent: OwnedRow | null = null;

  // Inner -> outer walk; keep the FIRST config seen per name so the innermost
  // owner wins, mirroring resolveAiConfig's single-name precedence.
  const byName = new Map<string, ResolvedAiConfig>();
  const collect = (configs: AiServiceConfig[], ownerType: AiConfigOwnerType): void => {
    for (const config of configs) {
      if (!byName.has(config.name)) byName.set(config.name, resolved(config, ownerType));
    }
  };

  if (appId) {
    const row = await db.app.findUnique({
      where: { id: appId },
      include: { aiServiceConfigs: { where: { enabled: true } } },
    });
    if (row) collect(row.aiServiceConfigs, 'APP');
    app = row;
  }

  if (agentId) {
    const row = await db.agent.findUnique({
      where: { id: agentId },
      include: { aiServiceConfigs: { where: { enabled: true } } },
    });
    if (row) collect(row.aiServiceConfigs, 'AGENT');
    agent = row;
  }

  const tenant = aiConfigTenantFor({ app, agent, organizationId: ctx.organizationId ?? null });

  if ('organizationId' in tenant) {
    collect(
      await db.aiServiceConfig.findMany({ where: { organizationId: tenant.organizationId, enabled: true } }),
      'ORGANIZATION',
    );
  }

  // The same tenant and platform-level rule as resolveAiConfig, so the picker never offers a configuration the
  // single-name walk would refuse to resolve.
  if (platformLevelOpen(tenant)) {
    collect(
      await db.aiServiceConfig.findMany({
        where: { hadronServerId: { not: null }, enabled: true },
        orderBy: { createdAt: 'asc' },
      }),
      'HADRON_SERVER',
    );
  }

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
