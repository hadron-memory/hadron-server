/**
 * #1177 §6 — the corpus lint rules, server-side.
 *
 * Thirteen rules over a node's declaration and body. They answer *is this node
 * exportable, and will the host do what its author expects* — judgment over
 * corpus inputs alone, with no file and no disk, which is what makes this half
 * of the split (A3) pure.
 *
 * Ported from `internal/skilldoc`'s `Lint` / `LintCollisions`. The message text
 * is part of the port: an operator reading `hadron skill lint` and a portal
 * reading this surface must be told the same thing about the same node, and a
 * reworded rule is a silent divergence between two clients of one corpus.
 *
 * **What can no longer be checked, since D12:** the name is STORED rather than
 * derived, so a name's PREFIX is unverifiable — `hadon-foo` lints clean. Shape
 * is checkable; correctness is not. `skill-prefix-missing` and
 * `skill-name-hand-set` were retired with the org prefix.
 */
import {
  classifyDeclaration,
  declaredSkill,
  EXPORTS_KEY,
  HOST_CLAUDE_SKILL,
  legacyAliasPaths,
  storedName,
} from './declaration.js';
import { MAX_DESCRIPTION_LEN, MAX_NAME_LEN, validName } from './name.js';
import { goTrimSpace, normalizeBody, normalizeDescription, runeCount } from './normalize.js';

/** Finding severities — the same vocabulary `spec lint` renders, so a caller
 *  scripting both surfaces sees one set of words. */
export type Severity = 'error' | 'warning';

/**
 * The slice of a node this contract reads.
 *
 * Filled from a BATCH projection, never a single-ref read: a single-ref read
 * compiles Mustache and would blank `{{name}}`-style placeholders out of a
 * verbatim export (D6, and `skill-content-has-template` exists to report
 * exactly those placeholders — reading them through the compiling surface
 * would make the rule unable to see its own subject).
 */
export interface SkillNode {
  urn: string;
  loc: string;
  memoryUrn: string;
  isRunnable: boolean;
  content: string;
  properties: unknown;
}

/** One lint result. `urn` names the node and `memory` the memory holding it,
 *  carried on every finding so a renderer never looks it back up. */
export interface Finding {
  urn: string;
  memory: string;
  rule: string;
  severity: Severity;
  message: string;
}

/** Trigger-shaped phrasing — the host matches descriptions against what the
 *  user says, so one that never says when to use the skill rarely fires. */
const TRIGGER_RE = /\buse (it |this )?when\b/i;

/** A COMPLETE `---…---` block. A body that merely opens with a horizontal
 *  rule is a body; the closing fence is what makes it frontmatter. */
const FRONTMATTER_RE = /^---\n(?:[\s\S]*?\n)?---\n?[\s\S]*$/;

/** A Mustache placeholder. Export is verbatim, so it ships as literal text —
 *  which may be intended (a briefing template) or a leak, hence a warning. */
const TEMPLATE_RE = /\{\{[^}]*\}\}/;

/**
 * The per-node rules.
 *
 * A node with no declaration and no malformed key yields nothing: **not
 * declared is not a defect, it is the opt-in working.**
 */
export function lintNode(node: SkillNode): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, message: string): void => {
    out.push({ urn: node.urn, memory: node.memoryUrn, rule, severity, message });
  };

  const { declaration, malformed } = classifyDeclaration(node.properties);
  for (const key of malformed) {
    add(
      'skill-declaration-malformed',
      'error',
      `properties.${key} is present but has the wrong shape — a declaration is {"description": "…"} with string fields; fix it or remove the key`,
    );
  }
  if (declaration === null) return out;

  // D12 moved the declaration to `exports.<host>`; the top-level keys are read
  // as aliases, so this steers them across.
  const migrated = declaration.key === `${EXPORTS_KEY}.${HOST_CLAUDE_SKILL}`;
  const strays = legacyAliasPaths(node.properties);
  if (!migrated) {
    add(
      'skill-legacy-key',
      'warning',
      `declared under properties.${declaration.key} — move it to properties.${EXPORTS_KEY}.${HOST_CLAUDE_SKILL} (D12: an object keyed by host, carrying {name, description, enable}); the old key is read as an alias only`,
    );
  } else if (strays.length > 0) {
    // Migrated, but an alias was left behind: the export reads the new shape,
    // so the old key is dead weight the retirement will strand.
    add(
      'skill-legacy-key',
      'warning',
      `${strays.join(' and ')} is still present beside properties.${EXPORTS_KEY}.${HOST_CLAUDE_SKILL} — remove the retired key; the export reads only the new shape`,
    );
  }

  const desc = normalizeDescription(declaration.description);
  const descLen = runeCount(desc);
  if (desc === '') {
    add(
      'skill-description-missing',
      'error',
      `properties.${declaration.key}.description is missing or empty — it is the trigger text the host matches against; the node cannot be exported without it`,
    );
  } else if (descLen > MAX_DESCRIPTION_LEN) {
    add(
      'skill-description-too-long',
      'error',
      `description is ${descLen} characters; the host caps it at ${MAX_DESCRIPTION_LEN} and TRUNCATES the rest in the skill listing, so trigger phrases past the cut never fire — shorten by ${descLen - MAX_DESCRIPTION_LEN}`,
    );
  }
  if (desc !== '' && !TRIGGER_RE.test(desc)) {
    add(
      'skill-description-no-trigger',
      'warning',
      'description never says when to use the skill ("Use when …") — the host matches descriptions against what the user says, and one with no trigger phrasing rarely fires',
    );
  }

  // D12: the name is stored, so a missing one has nothing to fall back to.
  if (storedName(declaration) === '') {
    add(
      'skill-name-missing',
      'error',
      `properties.${declaration.key}.name is missing or empty — since D12 the name is stored rather than derived, so there is nothing to fall back to; it is the skill's directory name and the host's identifier`,
    );
  } else if (!validName(declaration.name)) {
    add(
      'skill-name-invalid',
      'error',
      `skill name "${declaration.name}" is not a valid skill name (kebab-case, ≤${MAX_NAME_LEN} chars) — it is stored at properties.${declaration.key}.name, so that is what to change`,
    );
  }

  if (!node.isRunnable) {
    add(
      'skill-not-runnable',
      'error',
      'node declares a skill but isRunnable is not true — a skill is a runnable task; set it (`hadron node update <urn> --runnable`) or drop the declaration',
    );
  }

  const body = normalizeBody(node.content);
  if (goTrimSpace(body) === '') {
    add('skill-content-empty', 'error', 'node has no content — the body IS the skill; nothing to export');
  } else if (FRONTMATTER_RE.test(`${body}\n`)) {
    // Inspected as it will be EXPORTED (not further trimmed): an indented
    // `  ---` is content on disk, so it is content here.
    //
    // The appended newline mirrors Go's `MatchString(body + "\n")` and is
    // provably a NO-OP on this side: the pattern's tail is `[\s\S]*$`, and
    // JS's `$` without `m` matches only at the very end, so an extra trailing
    // newline is consumed by the tail and can never change the verdict. Kept
    // for textual parity with the reference — removing it would make the two
    // implementations differ for no behavioural gain, and a future change to
    // the Go pattern could make it load-bearing. Pinned by a test asserting
    // both forms agree, so it is a proven no-op rather than an untested line
    // (mutation M8 on PR #1233 did not red, which is what prompted this).
    add(
      'skill-content-has-frontmatter',
      'error',
      'content starts with a `---` frontmatter block — the node body is the skill BODY; frontmatter is composed at export from the declaration and would be doubled',
    );
  }
  if (TEMPLATE_RE.test(node.content)) {
    add(
      'skill-content-has-template',
      'warning',
      'content contains a {{…}} placeholder — export is verbatim, so it ships as literal text; keep it only if the skill is meant to carry a template',
    );
  }
  return out;
}

/**
 * Two declaring nodes that store the SAME skill name.
 *
 * Since D12 the name is stored rather than derived, so a collision is two
 * authors having typed one name — there is no prefix left to keep two orgs'
 * identically-named tasks apart, which is the cost D12 accepts. A node with no
 * stored name is skipped: `skill-name-missing` is its finding, not this.
 *
 * Cross-memory and cross-org by construction: the caller decides the
 * population, and a collision is only meaningful over the set that will be
 * exported together.
 */
export function lintCollisions(nodes: readonly SkillNode[]): Finding[] {
  const byName = new Map<string, SkillNode[]>();
  for (const node of nodes) {
    const declaration = declaredSkill(node.properties);
    if (declaration === null) continue;
    const name = storedName(declaration);
    if (name === '') continue;
    const group = byName.get(name) ?? [];
    group.push(node);
    byName.set(name, group);
  }

  const out: Finding[] = [];
  // Sorted for a deterministic report — a Map iterates in insertion order,
  // which is the order the caller happened to read the corpus in.
  for (const name of [...byName.keys()].sort()) {
    const group = byName.get(name)!;
    if (group.length < 2) continue;
    for (const node of group) {
      const others = group.filter((o) => o.urn !== node.urn).map((o) => o.urn);
      out.push({
        urn: node.urn,
        memory: node.memoryUrn,
        rule: 'skill-name-collision',
        severity: 'error',
        message: `stores skill name "${name}", and so does ${others.join(', ')} — one name, one skill directory; rename one or supersede the fork`,
      });
    }
  }
  return out;
}
