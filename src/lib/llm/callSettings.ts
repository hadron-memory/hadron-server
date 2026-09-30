/**
 * #1417 — the ONE place a config's `params` become provider call settings.
 * Every LLM call site spreads `callSettingsFor(...).settings`, so a run, the
 * tool loop, extraction and the config Test can never forward different
 * knobs for the same config.
 *
 * Mapped (installed SDK carriers, verified against ai 7.0.14 / @ai-sdk/openai
 * 4.0.7 / @ai-sdk/anthropic 4.0.7):
 *   - `temperature`           → core `temperature`, every provider
 *   - openai `reasoningEffort` → `providerOptions.openai.reasoningEffort`
 *                                (`reasoning_effort` / `reasoning.effort`)
 *   - anthropic `effort`       → `providerOptions.anthropic.effort`
 *                                (`output_config.effort`)
 *   - anthropic `thinking: true` → `providerOptions.anthropic.thinking =
 *                                {type: 'adaptive'}` (slice 2, Holger
 *                                2026-09-30). Adaptive adds NO budget on top
 *                                of max_tokens (only `{type: 'enabled'}` adds
 *                                `budget_tokens`), so the ceiling below holds.
 *   - `maxTokens`              → a per-config CEILING on the call's output:
 *                                min(params.maxTokens, the caller's budget)
 *                                (slice 2, Holger 2026-09-30). The caller's
 *                                budget (a run's remaining tokens, the Test
 *                                probe cap) is never raised by a config.
 *
 * Accepted but never sent (Holger 2026-09-30): unrecognised passthrough keys,
 * which stay valid on stored rows and new writes alike ("we can't know all"),
 * and are reported NOT_SENT. `toolCalling` is the tool-loop gate, not a
 * provider knob: neither mapped nor reported here.
 */

import type { CallWarning } from 'ai';

/**
 * What became of one saved knob on a real call:
 *   SENT      — carried to the provider adapter, and it raised no warning.
 *   ADJUSTED  — sent, but the adapter changed the value (e.g. clamped to its range).
 *   DROPPED   — the adapter removed it (e.g. temperature on a reasoning model).
 *   NOT_SENT  — this platform does not forward it; `reason` says why.
 */
export type KnobState = 'SENT' | 'ADJUSTED' | 'DROPPED' | 'NOT_SENT';

export interface KnobReport {
  param: string;
  state: KnobState;
  /** Why it was not sent, or the adapter's own warning text. */
  detail?: string;
}

export interface CallSettings {
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: {
    openai?: { reasoningEffort: string };
    anthropic?: { effort?: string; thinking?: { type: 'adaptive' } };
  };
}

/** Not provider knobs: the tool-loop gate, never forwarded from params. */
const CALL_SHAPING_PARAMS = new Set(['toolCalling']);

/**
 * The SDK `feature` name an adapter warning about each MAPPED param carries.
 * Every param `callSettingsFor` can send must be here, or an adapter that
 * drops it is reported as SENT (#1485 QA, Charles: @ai-sdk/openai drops
 * `reasoningEffort` on a non-reasoning Responses model and warns under that
 * name). The mapping test pins this list to the mapper's.
 */
export const WARNING_FEATURE: Record<string, string> = {
  temperature: 'temperature',
  reasoningEffort: 'reasoningEffort',
  effort: 'effort',
  thinking: 'thinking',
  // Anthropic/Bedrock limit an over-large ceiling to the model's maximum.
  maxTokens: 'maxOutputTokens',
};

/**
 * Map a config's saved params to call settings, with a report of what each
 * knob will do. Params are assumed already validated (`validateProviderAndParams`).
 *
 * `callerMaxTokens` is the call's own output budget (a run's remaining
 * tokens, the Test probe cap). The returned `settings.maxOutputTokens` is the
 * effective ceiling, the smaller of it and the config's `maxTokens`.
 */
export function callSettingsFor(config: { provider: string; params?: unknown }, callerMaxTokens?: number): {
  settings: CallSettings;
  knobs: KnobReport[];
} {
  const params =
    config.params && typeof config.params === 'object' && !Array.isArray(config.params)
      ? (config.params as Record<string, unknown>)
      : {};
  const settings: CallSettings = {};
  const knobs: KnobReport[] = [];
  const notSent = (param: string, detail: string) => knobs.push({ param, state: 'NOT_SENT', detail });
  if (callerMaxTokens != null) settings.maxOutputTokens = callerMaxTokens;

  for (const [param, value] of Object.entries(params)) {
    if (value === undefined || CALL_SHAPING_PARAMS.has(param)) continue;
    if (param === 'temperature' && typeof value === 'number') {
      settings.temperature = value;
      knobs.push({ param, state: 'SENT' });
    } else if (param === 'reasoningEffort' && config.provider === 'openai' && typeof value === 'string') {
      settings.providerOptions = { ...settings.providerOptions, openai: { reasoningEffort: value } };
      knobs.push({ param, state: 'SENT' });
    } else if (param === 'effort' && config.provider === 'anthropic' && typeof value === 'string') {
      settings.providerOptions = {
        ...settings.providerOptions,
        anthropic: { ...settings.providerOptions?.anthropic, effort: value },
      };
      knobs.push({ param, state: 'SENT' });
    } else if (param === 'thinking' && config.provider === 'anthropic' && typeof value === 'boolean') {
      if (value) {
        settings.providerOptions = {
          ...settings.providerOptions,
          anthropic: { ...settings.providerOptions?.anthropic, thinking: { type: 'adaptive' } },
        };
        knobs.push({ param, state: 'SENT', detail: 'adaptive' });
      } else {
        notSent(param, 'false is the provider default (no thinking); nothing to send.');
      }
    } else if (param === 'maxTokens' && typeof value === 'number') {
      const ceiling = callerMaxTokens == null ? value : Math.min(value, callerMaxTokens);
      settings.maxOutputTokens = ceiling;
      knobs.push(
        callerMaxTokens != null && callerMaxTokens < value
          ? { param, state: 'ADJUSTED', detail: `the call's own budget (${callerMaxTokens}) is lower than the config's ceiling (${value})` }
          : { param, state: 'SENT', detail: `output ceiling ${ceiling}` },
      );
    } else {
      notSent(param, `Not a setting this platform forwards for provider "${config.provider}".`);
    }
  }
  return { settings, knobs };
}

/**
 * Fold the adapter's warnings into the report: a SENT knob the adapter warned
 * about was changed or removed on the wire. A clamp keeps a value (ADJUSTED);
 * anything else removed it (DROPPED). The adapter's text is kept verbatim.
 */
export function withAdapterWarnings(
  knobs: KnobReport[],
  warnings: readonly CallWarning[] | undefined,
): KnobReport[] {
  if (!warnings?.length) return knobs;
  return knobs.map((knob) => {
    const feature = WARNING_FEATURE[knob.param];
    if (knob.state !== 'SENT' || !feature) return knob;
    const warning = warnings.find(
      (w): w is Extract<CallWarning, { feature: string }> => 'feature' in w && w.feature === feature,
    );
    if (!warning) return knob;
    return {
      ...knob,
      // A clamp or a limit keeps a value on the wire; anything else removed it.
      state: /clamp|limited to/i.test(warning.details ?? '') ? 'ADJUSTED' : 'DROPPED',
      ...(warning.details ? { detail: warning.details } : {}),
    };
  });
}
