/**
 * #1254 — the skill HOSTS the server can judge, one row each.
 *
 * A host is keyed by its D12 property key, verbatim (`exports.<host>`), which
 * is also what `--host` takes on the CLI. What differs per host is data, not
 * code: the render path is shared, because Codex reads the same `SKILL.md`
 * shape as Claude (measured on codex-cli 0.153.0 —
 * hrn:node:hadronmemory.com:hadron-cli:reference:codex-skill-host). The
 * DESTINATION directory is deliberately absent: where a file lives is the
 * client's fact (cor:agt:030:02 — paths are tunable, the server does no I/O).
 *
 * Limits are per host even though both rows agree today, because
 * cor:agt:030:05 makes the limit a property of the host ("per host, tunable")
 * and Codex has a second, softer budget Claude may not: every skill's catalog
 * line shares ~2% of the model's context window. The hard number below is the
 * per-description cut both hosts apply in the listing the model sees.
 */
/**
 * The original host (D10/D12). Defined HERE rather than in declaration.ts so
 * the registry has no import back into its consumer — declaration.ts
 * re-exports it, so existing imports keep working.
 */
export const HOST_CLAUDE_SKILL = 'claudeSkill';

export const HOST_CODEX_SKILL = 'codexSkill';

export interface SkillHost {
  /** The D12 key under `properties.exports`, verbatim. */
  key: string;
  /** Max skill-name length, in code points. */
  maxNameLength: number;
  /**
   * Max description length, in code points. Past it the host CUTS the
   * description in the listing its model sees (both hosts: 1,024, then an
   * ellipsis), so trailing trigger phrases never fire — cor:agt:030:05 takes
   * such a node out of export rather than truncating it.
   */
  maxDescriptionLength: number;
  /**
   * Whether the retired top-level `skill` / `claudeSkill` keys are read as
   * aliases for this host. Claude only: those keys predate hosts entirely and
   * always meant Claude, so reading them as a Codex declaration would publish
   * to a host nobody chose.
   */
  legacyAliases: boolean;
  /**
   * Skill names this host will not load from the root an export writes to,
   * compared case-insensitively (#1315). Claude Code reserves `synced`: it keeps
   * skills downloaded from claude.ai in `<root>/synced/` and SKIPS a skill
   * authored at that name "in any capitalization" in the personal, project and
   * enterprise roots (code.claude.com/docs/en/skills). An export of that name
   * would land inside Claude's own sync folder and never load.
   *
   * Only names the HOST reserves belong here. The `anthropic`/`claude` words the
   * Claude platform bans are an UPLOAD-surface rule (Skills API, claude.ai), not
   * a Claude Code one — Claude Code 2.1.143 loads such names — so they are not
   * listed: refusing them would turn a working skill into a refused one.
   */
  reservedNames: readonly string[];
}

/** Every supported host, in a stable order (Claude first, as the original). */
export const SKILL_HOSTS: readonly SkillHost[] = Object.freeze([
  Object.freeze({ key: HOST_CLAUDE_SKILL, maxNameLength: 64, maxDescriptionLength: 1024, legacyAliases: true, reservedNames: Object.freeze(['synced']) }),
  Object.freeze({ key: HOST_CODEX_SKILL, maxNameLength: 64, maxDescriptionLength: 1024, legacyAliases: false, reservedNames: Object.freeze([]) }),
]);

/** The host row for `key`, or null when the server has no renderer for it. */
export function skillHost(key: string): SkillHost | null {
  return SKILL_HOSTS.find((h) => h.key === key) ?? null;
}

/**
 * The host row for `key`, throwing on an unknown host. For library callers
 * that already validated the host at the boundary: an unknown host reaching
 * here is a programming error, and a silent Claude fallback would judge a
 * Codex declaration by the wrong rules.
 */
export function requireSkillHost(key: string): SkillHost {
  const host = skillHost(key);
  if (host === null) throw new Error(`unknown skill host "${key}"`);
  return host;
}
