/**
 * #1707 — a worker's model family (cor:agt:060:04).
 *
 * The family follows the BINDING: while a worker is bound, its family is its
 * live session's (`Session.family`); once it is unbound it has none from a
 * session, only whatever a live host registration can launch it as
 * (cor:agt:070:01, src/lib/agentTasks/hosts.ts). Storing the family on the
 * session rather than the worker is what makes "cleared on unbind" hold with
 * no writer to forget: ending, superseding and lapsing a session all end its
 * contribution, through the one liveness predicate (cor:agt:020:11).
 *
 * A FAMILY IS A MATCHING INPUT, NEVER AN AUTHORIZATION INPUT. It is
 * self-declared by whoever starts the session (or, from T6, by the host), so
 * it can be spoofed. Nothing may grant access on the strength of it.
 *
 * Derivation (Proposed in 060:04, #1707): an explicit `family` wins. Otherwise
 * the reported `llmModel` is read FIRST, because `tool` alone can't tell GLM
 * from Claude (GLM runs inside Claude Code). Only when no model is reported is
 * `tool` read, and only a tool that runs one family. A session nothing
 * classifies gets NO family: its worker is not matchable until one is given,
 * rather than being guessed into one.
 */

/** Valid custom tokens remain legal; provider aliases have one canonical identity. */
export const FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Model-name fragments, checked in order. GLM first: a GLM model id never names Claude, but be explicit. */
const MODEL_FAMILIES: readonly [RegExp, string][] = [
  [/(^|[^a-z])glm([^a-z]|$)/, 'glm'],
  [/claude|opus|sonnet|haiku/, 'claude'],
  [/gpt|codex|(^|[^a-z0-9])o[1-9]([^a-z0-9]|$)/, 'codex'],
  [/gemini/, 'gemini'],
];

/**
 * Tools that run exactly one family. `claude-code` is deliberately absent:
 * GLM runs inside it too, so the tool alone says nothing (#1707).
 */
const TOOL_FAMILIES: Readonly<Record<string, string>> = {
  codex: 'codex',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
};

/** Normalize an explicit family: trimmed, lowercased, and a valid token — or null when it isn't one. */
export function normalizeFamily(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (!FAMILY_PATTERN.test(v)) return null;
  return v === 'anthropic' ? 'claude' : v === 'openai' ? 'codex' : v;
}

/** All persisted spellings of an identity, for indexed reads of legacy rows. */
export function familySpellings(family: string): string[] {
  const f = normalizeFamily(family);
  return f === 'claude' ? ['claude', 'anthropic'] : f === 'codex' ? ['codex', 'openai'] : f ? [f] : [];
}

/**
 * #2252 / R189 — a coarse model tier, from the platform's ONE model-to-tier mapping (no per-App override). Raw model
 * names churn every release, so coordinators reason in tiers: opus-class `high`, sonnet-class `mid`, haiku-class `low`.
 * Only the Claude family is mapped: R189 authorizes the mapping's ownership, not guessing that another family's models
 * (GPT, GLM, Gemini) or an unlisted Claude model are equivalent to one. Everything else is null, never a guess. The
 * server team adds entries here when a model appears. Advisory like the family: self-declared, never authorization.
 */
export type ModelTier = 'high' | 'mid' | 'low';
export function tierOf(llmModel: string | null | undefined): ModelTier | null {
  const model = llmModel?.trim().toLowerCase();
  if (!model || deriveFamily({ llmModel: model }) !== 'claude') return null;
  if (/opus/.test(model)) return 'high';
  if (/sonnet/.test(model)) return 'mid';
  if (/haiku/.test(model)) return 'low';
  return null;
}

/** The family a reported model and tool imply, or null when they don't classify the session. */
export function deriveFamily(args: { llmModel?: string | null; tool?: string | null }): string | null {
  const model = args.llmModel?.trim().toLowerCase();
  if (model) {
    for (const [pattern, family] of MODEL_FAMILIES) if (pattern.test(model)) return family;
    // A model was reported and nothing recognized it: don't fall back to the
    // tool, which could only guess (an unknown model inside Claude Code is not
    // thereby Claude).
    return null;
  }
  const tool = args.tool?.trim().toLowerCase();
  return tool ? TOOL_FAMILIES[tool] ?? null : null;
}
