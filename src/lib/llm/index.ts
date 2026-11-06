/**
 * LLM invocation layer (spec 040 / headless-runner D-2026-05-09-001) — the
 * FIRST consumer of a resolved spec-036 AiServiceConfig.
 *
 * Deliberately small: single-shot text generation over the Vercel AI SDK,
 * dispatching on config.provider (anthropic | openai | glm | bedrock — glm
 * rides the OpenAI-compatible adapter). The headless runner's richer needs
 * (tool loops, streaming) grow HERE later; this module is the seed, not a
 * framework (plan §6 / 039 §7b).
 *
 * Key handling: AiServiceConfig.apiKeyEncrypted decrypts via decryptToken.
 * bedrock keys use the JSON-triple convention
 * { accessKeyId, secretAccessKey, region } (matches the embedding
 * SageMaker posture: explicit narrow credentials over ambient identity).
 */

import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  jsonSchema,
  tool as aiTool,
  stepCountIs,
  type LanguageModel,
} from 'ai';
import { AuthorFailError, type RunToolDef, type RunToolContext } from '../runner/tools/types.js';
import { admitAndExecuteTool, type ToolCallRecord } from '../runner/toolAdmission.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { ResolvedAiConfig } from '../aiConfig.js';
import { decryptToken } from '../tokenCrypto.js';
import { defaultEndpoint, effectiveApiStyle, explicitEndpoint, usesProcessCredential } from '../aiEndpoint.js';
import { guardedEndpointFetch } from './endpointFetch.js';
import { callSettingsFor, withAdapterWarnings, type KnobReport } from './callSettings.js';

export type { KnobReport, KnobState } from './callSettings.js';

export interface LlmRequest {
  system?: string;
  prompt: string;
  /** Hard output ceiling — callers pass their remaining run budget. */
  maxTokens?: number;
  /**
   * Abort the provider call after this many ms (#1385 review). A run has its
   * own deadline around the whole flow; a single interactive call (the
   * saved-config Test) has none, and an endpoint that accepts the connection
   * but never answers must not hold the request forever. An abort surfaces as
   * a transient LlmInvocationError.
   */
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  /**
   * #1417 — what each saved provider knob did on this call (sent, adjusted or
   * dropped by the adapter, or not forwarded). Empty when the config has none.
   */
  knobs?: KnobReport[];
}

export class LlmInvocationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly transient: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LlmInvocationError';
  }
}

/**
 * Build the model a call would use, WITHOUT calling it: every local refusal
 * `modelFor` makes (a malformed Bedrock key, a keyless config it won't run, an
 * unknown provider) surfaces here as the same LlmInvocationError, with no
 * network. The config test (#1385) runs it before charging its rate limit and
 * quota, so a config that could never reach a provider costs nothing.
 */
export function assertModelBuildable(resolved: ResolvedAiConfig): void {
  modelFor(resolved);
}

function modelFor(resolved: ResolvedAiConfig): LanguageModel {
  const { provider, model, apiKeyEncrypted } = resolved.config;
  const key = apiKeyEncrypted ? decryptToken(apiKeyEncrypted) : undefined;
  // #1373: an EXPLICIT endpoint is admin-chosen, so it goes through the
  // connect-time egress guard. Provider defaults are constants and do not.
  const endpoint = explicitEndpoint(resolved.config);
  // With no stored key, every SDK falls back to the PROCESS's credentials
  // (OPENAI_API_KEY, ANTHROPIC_API_KEY, the AWS chain). Sent to an
  // admin-chosen host, that would hand the server's own credential to
  // whoever runs it (#1389 review, Codex P1). An explicit endpoint therefore
  // requires the config's own key, and so does a provider whose DEFAULT host
  // is not the credential's issuer: glm's is Z.ai, and the OpenAI SDK would
  // send it the server's OPENAI_API_KEY (#1385 review). And only the
  // platform's own config may spend the platform credential at all (#1390).
  if (!key && !usesProcessCredential(resolved.config, resolved.ownerType)) {
    throw new LlmInvocationError(
      endpoint
        ? `Provider "${provider}" has an explicit endpoint but no stored key; the server's own credentials are never sent to a configured host.`
        : resolved.ownerType !== 'HADRON_SERVER'
          ? `This ${resolved.ownerType.toLowerCase()} AI config has no stored key; only the platform's own configs may use the server's credentials.`
          : `Provider "${provider}" needs a stored key; the server's own credentials belong to other providers.`,
      provider,
      false,
    );
  }
  const conn = endpoint ? { baseURL: endpoint, fetch: guardedEndpointFetch() } : {};
  // D3: the wire protocol for an OpenAI-compatible provider. Calling the
  // provider directly selects the Responses API in @ai-sdk/openai 4.x;
  // `.chat()` selects Chat Completions (#1374).
  const openAiCompatible = (client: ReturnType<typeof createOpenAI>) =>
    effectiveApiStyle(resolved.config) === 'CHAT_COMPLETIONS' ? client.chat(model) : client(model);
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: key, ...conn })(model);
    case 'openai':
      // Default RESPONSES; an OpenAI-compatible host that serves only Chat
      // Completions sets apiStyle, never inferred from the URL (#1374).
      return openAiCompatible(createOpenAI({ apiKey: key, ...conn }));
    case 'glm':
      // Default CHAT_COMPLETIONS: Zhipu and Z.ai serve only /chat/completions.
      return openAiCompatible(createOpenAI({ apiKey: key, baseURL: defaultEndpoint('glm')!, ...conn }));
    case 'openai-compatible':
      // #1373: a caller-named host speaking an OpenAI wire protocol. Its
      // endpoint is required at write time; a row that somehow lacks one must
      // never fall through to OpenAI's own host with this key.
      if (!endpoint) {
        throw new LlmInvocationError(`Provider "${provider}" has no endpoint configured.`, provider, false);
      }
      return openAiCompatible(createOpenAI({ apiKey: key, ...conn }));
    case 'bedrock': {
      let triple: { accessKeyId?: string; secretAccessKey?: string; region?: string } = {};
      if (key) {
        try {
          triple = JSON.parse(key) as typeof triple;
        } catch {
          throw new LlmInvocationError(
            'bedrock apiKey must be the JSON triple {accessKeyId, secretAccessKey, region}.',
            provider,
            false,
          );
        }
      }
      if (key && (!triple.accessKeyId || !triple.secretAccessKey || !triple.region)) {
        throw new LlmInvocationError(
          'bedrock apiKey JSON triple must carry accessKeyId, secretAccessKey, AND region.',
          provider,
          false,
        );
      }
      return createAmazonBedrock({
        region: triple.region,
        accessKeyId: triple.accessKeyId,
        secretAccessKey: triple.secretAccessKey,
        ...conn,
      })(model);
    }
    default:
      // aiConfig validates providers at write time; this is defense in depth.
      throw new LlmInvocationError(`Unknown provider "${provider}".`, provider, false);
  }
}

/** Heuristic transient classification for retry/nak decisions. */
function isTransient(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const status = (err as { statusCode?: number; status?: number }).statusCode ??
    (err as { status?: number }).status;
  if (status != null) return status === 429 || status >= 500;
  return /timeout|timed out|econnre|enotfound|eai_again|socket|network|overloaded|rate.?limit/.test(msg);
}

// ── Structured extraction (plan-multi-node D-MN-2) ──────────────────────────

/** One extraction-spec entry as carried on Node.data.extractionSpec. */
export interface ExtractionField {
  field: string;
  description?: string;
  shape?: string;
}

export interface LlmObjectResult {
  /** Extracted fields, restricted to the declared spec. */
  object: Record<string, unknown>;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  /** #1417 — see LlmResult.knobs. */
  knobs?: KnobReport[];
}

/**
 * v1 shape vocabulary (D-MN-2): number / boolean / string[] map to their
 * JSON-schema types; anything else — including absent — degrades to string,
 * never throws. Fields are best-effort (the model may not find them), so
 * none are `required`.
 */
function shapeToJsonSchema(shape: string | undefined): Record<string, unknown> {
  // `shape` crosses a JSON boundary (Node.data) — a non-string value is
  // malformed data, which degrades to string like any unknown shape
  // (PR-532 review, Gemini).
  switch (typeof shape === 'string' ? shape.trim() : 'string') {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'string[]': return { type: 'array', items: { type: 'string' } };
    default: return { type: 'string' };
  }
}

function extractionSchema(fields: ExtractionField[]) {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    properties[f.field] = {
      ...shapeToJsonSchema(f.shape),
      ...(f.description ? { description: f.description } : {}),
    };
  }
  return jsonSchema<Record<string, unknown>>({
    type: 'object',
    properties,
    additionalProperties: false,
  });
}

/** Keep only declared fields — the object merges into a persisted envelope. */
function restrictToSpec(
  raw: unknown,
  fields: ExtractionField[],
): Record<string, unknown> {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (obj[f.field] !== undefined) out[f.field] = obj[f.field];
  }
  return out;
}

/**
 * Structured single-shot extraction — the flow walker calls this instead of
 * `generateText` when the node declares `data.extractionSpec`. Same provider
 * dispatch, same token accounting, same transient classification.
 *
 * Providers without native structured output fall back — inside this
 * wrapper, invisible to the runner — to one JSON-mode text completion
 * parsed for the first JSON object in the reply.
 */
// Native structured-output attempts are hard-capped: a provider that HANGS
// (rather than erroring) must trip the fallback instead of eating the whole
// run timeout. Observed live: bedrock claude-sonnet-4-6 generateObject never
// returned on alpha (2026-07-07) — zero tokens spent, run TIMED_OUT.
const EXTRACTION_NATIVE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.LLM_EXTRACTION_NATIVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
})();

/** Providers whose native structured-output path is not trusted yet. */
const JSON_PROMPT_ONLY_PROVIDERS = new Set(['bedrock', 'glm', 'openai-compatible']);

export async function generateExtraction(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  fields: ExtractionField[],
): Promise<LlmObjectResult> {
  const { provider, model } = resolved.config;
  // Known-bad native paths skip straight to the JSON-prompt fallback
  // (bedrock: observed hang; glm: openai-compatible shim, untested).
  if (JSON_PROMPT_ONLY_PROVIDERS.has(provider)) {
    return extractViaJsonPrompt(resolved, req, fields);
  }
  const { settings, knobs } = callSettingsFor(resolved.config, req.maxTokens);
  try {
    const out = await aiGenerateObject({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      schema: extractionSchema(fields),
      ...settings,
      abortSignal: AbortSignal.timeout(EXTRACTION_NATIVE_TIMEOUT_MS),
    });
    return {
      object: restrictToSpec(out.object, fields),
      tokensIn: out.usage?.inputTokens ?? 0,
      tokensOut: out.usage?.outputTokens ?? 0,
      provider,
      model,
      knobs: withAdapterWarnings(knobs, out.warnings),
    };
  } catch (err) {
    if (err instanceof LlmInvocationError) throw err;
    // Our own abort cap fired: the native path hung. Falling back is the
    // point — retrying would hit the same hang (and the abort message
    // contains "timeout", which isTransient would misread as retryable).
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return extractViaJsonPrompt(resolved, req, fields);
    }
    if (isTransient(err)) {
      throw new LlmInvocationError(
        `LLM extraction failed (${provider}/${model}): ${String((err as Error)?.message ?? err)}`,
        provider,
        true,
        { cause: err },
      );
    }
    // Non-transient — most likely a provider without native structured
    // output. One JSON-prompted text completion, then parse.
    return extractViaJsonPrompt(resolved, req, fields);
  }
}

async function extractViaJsonPrompt(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  fields: ExtractionField[],
): Promise<LlmObjectResult> {
  const fieldLines = fields
    .map((f) => {
      // Same JSON-boundary defense as shapeToJsonSchema (PR-532 review).
      const shape = typeof f.shape === 'string' ? f.shape.trim() : 'string';
      return `- "${f.field}" (${shape})${f.description ? `: ${f.description}` : ''}`;
    })
    .join('\n');
  const out = await generateText(resolved, {
    ...(req.system ? { system: req.system } : {}),
    prompt:
      `${req.prompt}\n\n` +
      `Respond with ONLY a JSON object (no prose, no code fence) carrying these fields:\n${fieldLines}`,
    ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
  });
  const start = out.text.indexOf('{');
  const end = out.text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new LlmInvocationError(
      `LLM extraction fallback returned no JSON object (${resolved.config.provider}/${resolved.config.model}).`,
      resolved.config.provider,
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.text.slice(start, end + 1));
  } catch {
    throw new LlmInvocationError(
      `LLM extraction fallback returned unparsable JSON (${resolved.config.provider}/${resolved.config.model}).`,
      resolved.config.provider,
      false,
    );
  }
  return {
    object: restrictToSpec(parsed, fields),
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    provider: out.provider,
    model: out.model,
    knobs: out.knobs,
  };
}

// ── Tool loop (plan-tools §4, phase 1) ──────────────────────────────────────

/** Spike-verified 2026-07-07 (_hs_local/spike-tool-loop.mjs): bedrock tool-
 *  calling is healthy — the #535 hang is generateObject-specific. glm's
 *  openai-compatible shim is untested ⇒ excluded (D-TL-8). */
const TOOL_LOOP_PROVIDERS = new Set(['anthropic', 'openai', 'bedrock']);

const DEFAULT_TOOL_STEP_CAP = (() => {
  const raw = Number(process.env.RUN_MAX_TOOL_STEPS_PER_HOP);
  return Number.isFinite(raw) && raw > 0 ? raw : 8; // D-TL-4
})();

export type { ToolCallRecord } from '../runner/toolAdmission.js';

export interface LlmToolLoopResult extends LlmResult {
  toolCalls: ToolCallRecord[];
}

/**
 * #862 — the usage the provider already billed for the steps a tool-loop call
 * COMPLETED before it was rejected (cor:agt:010:02: every action decrements the
 * run's budget on that call). Carried on the thrown error, never invented:
 *
 *   - absent means unknown: no step completed, or none reported usage;
 *   - present with zeros means a step really measured zero;
 *   - the step that failed is never included, and is never represented as zero.
 *
 * A step is measured when the SDK gave a defined input or output count; an
 * undefined side of a measured step counts as 0 on that side.
 */
export interface PartialUsage {
  tokensIn: number;
  tokensOut: number;
  /** Completed steps that reported usage; >= 1 whenever the property exists. */
  measuredSteps: number;
}

/** The measured usage of a rejected tool-loop call, or undefined when unknown. */
export function partialUsageOf(err: unknown): PartialUsage | undefined {
  return (err as { partialUsage?: PartialUsage } | null)?.partialUsage;
}

/** Unverified provider for the tool loop (D-TL-8) — typed, not string-matched
 *  (PR-545 review, Copilot). Always non-transient: a tools-node must never
 *  silently run without its tools. */
export class NoToolSupportError extends LlmInvocationError {
  constructor(provider: string) {
    super(
      `Provider "${provider}" is not verified for the run tool loop (NO_TOOL_SUPPORT).`,
      provider,
      false,
    );
    this.name = 'NoToolSupportError';
  }
}

export { ToolDeniedError, ToolExecutionError } from '../runner/toolAdmission.js';

export interface ToolLoopOpts {
  /** Max LLM steps for this hop (D-TL-4). Default RUN_MAX_TOOL_STEPS_PER_HOP (8). */
  stepCap?: number;
  /** Per-call governance (D-TL-3): receives the definition's explicit policy
   *  action, or `tool.<name>` by default. False = deny. */
  onToolCall?: (action: `tool.${string}`, cost: 0 | 1) => Promise<boolean>;
  /** Handler context (trail logging; kernel extends per phase). */
  toolCtx: RunToolContext;
}

/**
 * Bounded multi-step tool loop — the third LLM entry point beside
 * generateText/generateExtraction: same provider dispatch, same token
 * accounting (summed across steps), same transient classification for
 * provider errors raised BEFORE any tool executed.
 *
 * Error contract (plan-tools D-TL-6): AuthorFailError and ToolDeniedError
 * and ToolExecutionError propagate to the caller un-wrapped — the kernel
 * maps them to AUTHOR_FAIL / ACTIVATION_DENIED / TOOL_FAILED. They are
 * captured OUTSIDE the SDK's own error wrapping via a closure, so SDK
 * repackaging can never swallow them.
 */
export async function generateWithTools(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  toolDefs: readonly RunToolDef[],
  opts: ToolLoopOpts,
): Promise<LlmToolLoopResult> {
  const { provider, model } = resolved.config;
  // An openai-compatible host is unverified by default; its config opts in
  // with params.toolCalling once the operator knows the host does tools.
  const optedIn =
    provider === 'openai-compatible' &&
    (resolved.config.params as { toolCalling?: unknown } | null | undefined)?.toolCalling === true;
  if (!TOOL_LOOP_PROVIDERS.has(provider) && !optedIn) {
    // Loud, non-transient: silently running a tools-node WITHOUT its tools
    // would change semantics (D-TL-8).
    throw new NoToolSupportError(provider);
  }

  const toolCalls: ToolCallRecord[] = [];
  // Our terminal errors, captured before the SDK can wrap them.
  let fatal: Error | null = null;
  const terminal = (): Error | null => fatal;
  // #862: usage of the steps the SDK reports complete, for a rejected call.
  const measured: Array<{ tokensIn: number; tokensOut: number }> = [];
  const withMeasuredUsage = <E extends Error>(err: E): E => {
    // The usage belongs to THIS invocation: an error instance thrown again by a
    // later call (a reused provider error) must not carry the last call's steps.
    if (measured.length === 0) delete (err as E & { partialUsage?: PartialUsage }).partialUsage;
    if (measured.length > 0) {
      (err as E & { partialUsage?: PartialUsage }).partialUsage = {
        tokensIn: measured.reduce((n, step) => n + step.tokensIn, 0),
        tokensOut: measured.reduce((n, step) => n + step.tokensOut, 0),
        measuredSteps: measured.length,
      };
    }
    return err;
  };

  const sdkTools = Object.fromEntries(
    toolDefs.map((def) => [
      def.name,
      aiTool({
        description: def.description,
        inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema as never),
        execute: async (args: Record<string, unknown>) => {
          try {
            // #670: admission + execute is ONE function shared with the script node (cor:agt:010:04).
            // #2418: ai@7 starts every call of a step together, so a sibling can be admitted (and charged)
            // while a terminal runs. Past admission, an already-set terminal means this call's side effect
            // must not run: `beforeExecute` throws the first terminal (nothing replaces it).
            return await admitAndExecuteTool(def, args, {
              onToolCall: opts.onToolCall,
              toolCtx: opts.toolCtx,
              beforeExecute: () => {
                const ended = terminal();
                if (ended) throw ended;
              },
              record: (r) => toolCalls.push(r),
            });
          } catch (err) {
            // The FIRST terminal wins: with parallel calls in one step a later sibling's failure must not
            // replace the error that ended the run. admitAndExecuteTool already classified `err`.
            if (fatal === null) fatal = err as Error;
            // ai@7 turns a throwing execute into a `tool-error` part and keeps looping, so a throw alone no
            // longer aborts (#2412): `stopWhen` ends the loop after this step, and the resolved path rethrows.
            throw fatal;
          }
        },
      }),
    ]),
  );

  const { settings, knobs } = callSettingsFor(resolved.config, req.maxTokens);
  try {
    const out = await aiGenerateText({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      tools: sdkTools,
      stopWhen: [stepCountIs(opts.stepCap ?? DEFAULT_TOOL_STEP_CAP), () => terminal() !== null],
      onStepEnd: (step) => {
        const { inputTokens, outputTokens } = step.usage ?? {};
        if (inputTokens !== undefined || outputTokens !== undefined) {
          measured.push({ tokensIn: inputTokens ?? 0, tokensOut: outputTokens ?? 0 });
        }
      },
      ...settings,
    });
    // Backstop (#2412): the SDK resolved after a tool terminal. Our error
    // wins, un-wrapped, so the kernel maps it (AUTHOR_FAIL / ACTIVATION_DENIED /
    // TOOL_FAILED) instead of recording a success. Thrown inside this try, so
    // the catch below attaches the steps it completed (#862).
    const ended = terminal();
    if (ended) throw ended;
    const usage = out.totalUsage ?? out.usage; // summed across steps (spike-pinned)
    return {
      text: out.text,
      tokensIn: usage?.inputTokens ?? 0,
      tokensOut: usage?.outputTokens ?? 0,
      provider,
      model,
      // Every step sends the same settings; a warning on any step counts.
      knobs: withAdapterWarnings(knobs, out.steps.flatMap((step) => step.warnings ?? [])),
      toolCalls,
    };
  } catch (err) {
    const ended = terminal();
    if (ended) throw withMeasuredUsage(ended); // our terminal errors win over SDK wrapping
    if (err instanceof LlmInvocationError) throw withMeasuredUsage(err);
    // Transient (⇒ bus-redelivery retry) ONLY while no SIDE-EFFECTING tool
    // has executed (D-TL-6, refined per PR-540 Gemini): cost-0 tools are
    // retry-safe — reads are pure, and hadron_log writes only to the
    // in-memory hop element, which a transient reset never persisted.
    const costOf = new Map(toolDefs.map((t) => [t.name, t.cost]));
    const sideEffectRan = toolCalls.some((c) => c.ok && (costOf.get(c.name) ?? 1) > 0);
    throw withMeasuredUsage(new LlmInvocationError(
      `LLM tool loop failed (${provider}/${model}): ${String((err as Error)?.message ?? err)}`,
      provider,
      isTransient(err) && !sideEffectRan,
      { cause: err },
    ));
  }
}

export async function generateText(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
): Promise<LlmResult> {
  const { provider, model } = resolved.config;
  const { settings, knobs } = callSettingsFor(resolved.config, req.maxTokens);
  try {
    const out = await aiGenerateText({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      ...settings,
      ...(req.timeoutMs != null ? { abortSignal: AbortSignal.timeout(req.timeoutMs), maxRetries: 0 } : {}),
    });
    return {
      text: out.text,
      tokensIn: out.usage?.inputTokens ?? 0,
      tokensOut: out.usage?.outputTokens ?? 0,
      provider,
      model,
      knobs: withAdapterWarnings(knobs, out.warnings),
    };
  } catch (err) {
    if (err instanceof LlmInvocationError) throw err;
    throw new LlmInvocationError(
      `LLM call failed (${provider}/${model}): ${String((err as Error)?.message ?? err)}`,
      provider,
      isTransient(err),
      { cause: err },
    );
  }
}
