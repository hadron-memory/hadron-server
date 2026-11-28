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
 *
 * The mapping is a list of DELIBERATE model-id shapes, not a search for a tier word: the checked gate says an unknown
 * model returns null, so a string that merely CONTAINS `opus`/`sonnet`/`haiku` (`octopus-v1`, `my-sonnet-finetune`,
 * `gpt-opus-5`) or only names the tier (`opus`, `claude-opus`) is null, and `deriveFamily` (which is permissive on
 * purpose, to classify a worker) is never a witness here. Anthropic's id shapes are current
 * `claude-<tier>-<version>` and legacy `claude-<version>-<tier>`, with an optional Bedrock/Vertex `[region.]anthropic.`
 * prefix; other vendors' shapes are listed in {@link VENDOR_TIER_SHAPES} (#5175, placements Proposed). The server team
 * adds a shape here when a model appears. Advisory like the family: self-declared, never authorization.
 */
export type ModelTier = 'high' | 'mid' | 'low';
const TIER_BY_NAME: Readonly<Record<string, ModelTier>> = { opus: 'high', sonnet: 'mid', haiku: 'low', fable: 'high' };
const CLAUDE_ID_PREFIX = '(?:(?:[a-z]{2}\\.)?anthropic\\.)?claude-';
const CURRENT_ID = new RegExp(`^${CLAUDE_ID_PREFIX}(opus|sonnet|haiku|fable)-\\d`);
const LEGACY_ID = new RegExp(`^${CLAUDE_ID_PREFIX}\\d+(?:-\\d+)?-(opus|sonnet|haiku)(?:-|$)`);
/**
 * #5175 — other vendors' deliberate id shapes, placed by each vendor's own line-up as the CHECKED records it
 * (hadron-server#5175 comment 7170251620; Holger 2026-11-25, "Vendor positioning"): Anthropic's fable line `high`; the
 * glm and gpt STANDARD lines `mid` (glm-5.3 is GLM's standard line, so `mid`; the gpt luna/codex lines likewise); a
 * vendor's small or fast variants (`air`, `flash`, `mini`, `nano`) `low`; deepseek's `pro` line `high` per its vendor's
 * positioning. EVERY placement is PROPOSED and Holger may overrule one; this PR is the proposal and its pins change if
 * one is overruled. Anchored whole-id shapes like the Claude ones, so a string that merely contains `glm` or `gpt` is
 * null. Versions are ENUMERATED, not open: a model appears here only once someone has placed it, so `glm-6` or `gpt-7`
 * stays null and `TIER_UNKNOWN` under a floor (R190, cor:agt:060:04) until the server team adds it.
 */
const GLM_VERSIONS = '(?:4\\.5|4\\.6|4\\.7|5|5\\.3)';
const GPT_VERSIONS = '(?:5|5\\.1|6)';
const DEEPSEEK_VERSIONS = '(?:4)';
// The roster reports `deepseek/deepseek-v4-pro-0813`: an optional `deepseek/` router prefix and `-MMDD` release stamp.
const deepseek = (line: string) => new RegExp(`^(?:deepseek/)?deepseek-v${DEEPSEEK_VERSIONS}-${line}(?:-\\d{4})?$`);
const VENDOR_TIER_SHAPES: ReadonlyArray<readonly [RegExp, ModelTier]> = [
  [new RegExp(`^glm-${GLM_VERSIONS}$`), 'mid'],
  [new RegExp(`^glm-${GLM_VERSIONS}-(?:air|flash)$`), 'low'],
  [new RegExp(`^gpt-${GPT_VERSIONS}(?:-(?:luna|codex))?$`), 'mid'],
  [new RegExp(`^gpt-${GPT_VERSIONS}-(?:mini|nano)$`), 'low'],
  [deepseek('pro'), 'high'],
  [deepseek('flash'), 'low'],
];
export function tierOf(llmModel: string | null | undefined): ModelTier | null {
  const model = llmModel?.trim().toLowerCase();
  if (!model) return null;
  const name = (CURRENT_ID.exec(model) ?? LEGACY_ID.exec(model))?.[1];
  if (name) return TIER_BY_NAME[name] ?? null;
  return VENDOR_TIER_SHAPES.find(([shape]) => shape.test(model))?.[1] ?? null;
}

/**
 * #4232 (S9 of #4229) — the tier of a model a MANAGER ASSIGNED to a worker on a host (S1a, #4222), as opposed to one a
 * session reported about itself. The assigned model is what the host launches (`--model opus`), so the bare launcher
 * aliases `opus` / `sonnet` / `haiku` are the usual spelling and count here; {@link tierOf} stays strict for the
 * self-declared binding model, where a bare tier word proves nothing. Anything else is {@link tierOf}'s answer.
 */
export function tierOfAssignedModel(model: string | null | undefined): ModelTier | null {
  const m = model?.trim().toLowerCase();
  if (!m) return null;
  return Object.hasOwn(TIER_BY_NAME, m) ? TIER_BY_NAME[m] : tierOf(m);
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
