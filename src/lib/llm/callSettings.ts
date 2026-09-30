/**
 * #1417 slice 1 — the ONE place a config's `params` become provider call
 * settings. Every LLM call site spreads `callSettingsFor(...).settings`, so a
 * run, the tool loop, extraction and the config Test can never forward
 * different knobs for the same config.
 *
 * Mapped (installed SDK carriers, verified against ai 7.0.14 / @ai-sdk/openai
 * 4.0.7 / @ai-sdk/anthropic 4.0.7):
 *   - `temperature`           → core `temperature`, every provider
 *   - openai `reasoningEffort` → `providerOptions.openai.reasoningEffort`
 *                                (`reasoning_effort` / `reasoning.effort`)
 *   - anthropic `effort`       → `providerOptions.anthropic.effort`
 *                                (`output_config.effort`)
 *
 * Deliberately NOT sent, pending Holger's rulings (#1417 slice 2, Ada #2718):
 * `thinking` (the SDK adds its budget ON TOP of max_tokens, which changes the
 * run's token budget), and every unrecognised passthrough key. `maxTokens` and
 * `toolCalling` are not provider knobs: the caller's budget and the tool-loop
 * gate own them, so they are neither mapped nor reported here.
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
  providerOptions?: {
    openai?: { reasoningEffort: string };
    anthropic?: { effort: string };
  };
}

/** Not provider knobs: shaped by the caller, never forwarded from params. */
const CALL_SHAPING_PARAMS = new Set(['maxTokens', 'toolCalling']);

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
};

/**
 * Map a config's saved params to call settings, with a report of what each
 * knob will do. Params are assumed already validated (`validateProviderAndParams`).
 */
export function callSettingsFor(config: { provider: string; params?: unknown }): {
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

  for (const [param, value] of Object.entries(params)) {
    if (value === undefined || CALL_SHAPING_PARAMS.has(param)) continue;
    if (param === 'temperature' && typeof value === 'number') {
      settings.temperature = value;
      knobs.push({ param, state: 'SENT' });
    } else if (param === 'reasoningEffort' && config.provider === 'openai' && typeof value === 'string') {
      settings.providerOptions = { ...settings.providerOptions, openai: { reasoningEffort: value } };
      knobs.push({ param, state: 'SENT' });
    } else if (param === 'effort' && config.provider === 'anthropic' && typeof value === 'string') {
      settings.providerOptions = { ...settings.providerOptions, anthropic: { effort: value } };
      knobs.push({ param, state: 'SENT' });
    } else if (param === 'thinking' && config.provider === 'anthropic') {
      notSent(param, 'Not forwarded yet: enabling thinking spends a token budget beyond the output ceiling, which awaits a ruling (#1417).');
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
      state: /clamp/i.test(warning.details ?? '') ? 'ADJUSTED' : 'DROPPED',
      ...(warning.details ? { detail: warning.details } : {}),
    };
  });
}
