/**
 * #1177 §6 — the corpus lint rules, server-side.
 *
 * FIFTEEN rules over a node's declaration and body: thirteen per node and per
 * host (`lintNode`), `skill-name-collision`, which is corpus-wide and per host
 * (`lintCollisions`), and `skill-unknown-host-key`, which is per node and
 * attributed to NO host (`lintUnknownHostKeys`, #1292). The twelfth per-node
 * rule, `skill-name-reserved` (#1315), was server-only until hadron-cli#712
 * ported it; the Go-generated parity fixtures now pin it in their `lintReserved`
 * section, word for word. The thirteenth, `skill-description-markup` (#1341),
 * is mirrored in Go by hadron-cli#722 and pinned the same way, per host, in
 * `lintMarkup`. They answer *is this node
 * exportable, and will the host do what its author expects* — judgment over
 * corpus inputs alone, with no file and no disk, which is what makes this half
 * of the split (A3) pure.
 *
 * §6 of the spec says "13 rules" and is counting one more:
 * `skill-node-unavailable`, which is synthesized by the COMMAND layer for a
 * ref it could not read. That one is not a judgment about a node — it is a
 * report about a read that failed — so it cannot live in a pure function over
 * a node it does not have. Said here rather than left as an off-by-one,
 * because counting it in this header would misstate what the port covers
 * (@copilot, PR #1233). (The count above reached thirteen in #1292 with a
 * rule of its own, fourteen in #1315 and fifteen in #1341; the spec's §6 figure
 * predates all three.)
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
  isEnabled,
  legacyAliasPaths,
  storedName,
  unknownHostKeys,
} from './declaration.js';
import { goQuote } from './goQuote.js';
import { isHostReservedName, requireSkillHost, SKILL_HOSTS } from './hosts.js';
import { validName } from './name.js';
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

/** A Mustache placeholder. Export copies it as is, so it ships as literal
 *  text, which may be intended (a briefing template) or a leak, hence a warning.
 *
 *  #2943 / hadron-cli#1166: an include tag `{{> part}}` is NOT a placeholder.
 *  The export resolver splices it (#2048; the opener is exactly `{{>`, as in
 *  `includes/parseIncludeTags.ts`), so it gets no finding here. Written without
 *  a lookahead so the Go mirror (RE2) can use the same pattern: a match is `{{`,
 *  then nothing or a first character that is neither `>` nor `}`, then `}}`. */
const TEMPLATE_RE = /\{\{(?:[^>}][^}]*)?\}\}/;

/**
 * The measured Cowork predicate (#1341): a `<`, then at least one character
 * that is not `>`, then a `>`. Of the two predicates that fit all 20 probe
 * cases, this is the broader one: it refuses a nested `<<>`, which the narrower
 * `<[^<>]+>` would accept and which was not measured. Refusing the superset errs
 * toward a plugin that uploads. Same pattern as hadron-cli#722's Go mirror.
 */
const DESCRIPTION_MARKUP_RE = /<[^>]+>/;

/**
 * The per-node rules.
 *
 * A node with no declaration and no malformed key yields nothing: **not
 * declared is not a defect, it is the opt-in working.**
 */
export function lintNode(node: SkillNode, host: string = HOST_CLAUDE_SKILL): Finding[] {
  const hostRow = requireSkillHost(host);
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, message: string): void => {
    out.push({ urn: node.urn, memory: node.memoryUrn, rule, severity, message });
  };

  const { declaration, malformed } = classifyDeclaration(node.properties, host);
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
  // Claude only: the retired keys alias to Claude alone, so for any other host
  // the declaration is always at exports.<host> and there is nothing to steer.
  const migrated = !hostRow.legacyAliases || declaration.key === `${EXPORTS_KEY}.${host}`;
  const strays = hostRow.legacyAliases ? legacyAliasPaths(node.properties) : [];
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
  } else if (descLen > hostRow.maxDescriptionLength) {
    add(
      'skill-description-too-long',
      'error',
      `description is ${descLen} characters; the host caps it at ${hostRow.maxDescriptionLength} and TRUNCATES the rest in the skill listing, so trigger phrases past the cut never fire — shorten by ${descLen - hostRow.maxDescriptionLength}`,
    );
  }
  // #1341: what Cowork's validator refuses as an XML tag ("cannot contain XML
  // tags"): `<memory>`, `</end>`, `1 < 2 and 3 > 2`, an email in angle brackets.
  // A lone `<` or `>`, `<>`, `<3` and `a<b` pass. An error, so the planner's
  // lint gate keeps the node out of export for this host and preserves any
  // file already there; checked independently of the length rule.
  const markup = hostRow.rejectsDescriptionMarkup ? DESCRIPTION_MARKUP_RE.exec(desc) : null;
  if (markup !== null) {
    add(
      'skill-description-markup',
      'error',
      `description contains ${goQuote(markup[0])}, which ${hostRow.key}'s upload validator refuses as an XML tag (a "<" followed later by a ">", with at least one character between) — reword it in plain words, e.g. "a memory" for "<memory>"`,
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
  } else if (!validName(declaration.name, hostRow.maxNameLength)) {
    add(
      'skill-name-invalid',
      'error',
      `skill name "${declaration.name}" is not a valid skill name (kebab-case, ≤${hostRow.maxNameLength} chars) — it is stored at properties.${declaration.key}.name, so that is what to change`,
    );
  }
  // #1315: a name the HOST refuses to load from the export root. An error, so
  // the planner's lint gate keeps it out of export and preserves any file
  // already there — the host would ignore the file anyway. Checked
  // INDEPENDENTLY of the grammar check (@copilot, PR #1318): `Synced` fails
  // both, and reporting only the grammar would reveal the reservation as a
  // second error after the author fixed the case.
  if (storedName(declaration) !== '' && isHostReservedName(hostRow, storedName(declaration))) {
    add(
      'skill-name-reserved',
      'error',
      `skill name "${declaration.name}" is reserved by ${declaration.host}: the host keeps its own skills in a folder of that name and skips a skill authored there, so the exported file would never load — rename properties.${declaration.key}.name`,
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
 * The rule for a key under `properties.exports` that names no host.
 *
 * PROVISIONAL NAME, proposed by hadron-cli (team chat #1206) and pending the
 * specs engineer: kept in ONE constant so the agreed spelling is a one-line
 * change here and in the Go reference together.
 */
export const RULE_UNKNOWN_HOST_KEY = 'skill-unknown-host-key';

/**
 * The host-independent pass: one WARNING per unknown `exports.<key>`
 * (cor:agt:030:06, D-2026-09-23-E).
 *
 * Deliberately NOT part of `lintNode(node, host)`. Every finding that returns
 * is attributed to a host, and this one belongs to none — emitted from each
 * host's pass it would merge into one row claiming all of them. A warning,
 * never an error: an unrecognised key is reported, and never blocks anything.
 */
export function lintUnknownHostKeys(node: SkillNode): Finding[] {
  return unknownHostKeys(node.properties).map((key) => unknownHostKeyFinding(node, key));
}

/** The one warning for one unknown key: shared by the full pass and by a caller that lists only some keys. */
export function unknownHostKeyFinding(node: SkillNode, key: string): Finding {
  const known = SKILL_HOSTS.map((h) => h.key).join(', ');
  return {
    urn: node.urn,
    memory: node.memoryUrn,
    rule: RULE_UNKNOWN_HOST_KEY,
    severity: 'warning',
    // Word for word Go's LintUnknownHostKeys (@copilot, PR #1296), with the
    // key quoted as Go's %q quotes it: the key is author-controlled, so it can
    // carry exactly the characters JSON.stringify and Go escape differently.
    message: `properties.${EXPORTS_KEY} key ${goQuote(key)} names no skill host (supported: ${known}) — nothing exports it, and it is not read as an alias for any host; rename it to a supported key or remove it`,
  };
}

/**
 * The summary warning for unknown keys a report does not LIST (#1292; @codex
 * P1 then @copilot, PR #1296). Server-only: Go lists every key, and a report
 * over a writer-controlled object has to bound what it builds. The keys are
 * counted, not dropped, and still a warning: an unknown key never blocks.
 */
export function unknownHostKeysOmittedFinding(node: SkillNode, omitted: number): Finding {
  return {
    urn: node.urn,
    memory: node.memoryUrn,
    rule: RULE_UNKNOWN_HOST_KEY,
    severity: 'warning',
    message: `properties.${EXPORTS_KEY} carries ${omitted} more unrecognised key(s) not listed in this report (too many, or too long to show) — nothing exports them, and they are not read as an alias for any host; remove them`,
  };
}

/**
 * Two ENABLED declarations, for one host, that store the SAME skill name.
 *
 * Only enabled declarations count (cor:agt:030:06, D-2026-09-23-C): one that
 * is off is not exported, so it claims no name. Lint judges a disabled
 * declaration's NAME for shape all the same (`lintNode`); only the collision
 * rule is scoped to what would actually be written.
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
export function lintCollisions(nodes: readonly SkillNode[], host: string = HOST_CLAUDE_SKILL): Finding[] {
  // Validate at ENTRY, not only inside the loop: over an empty corpus the
  // loop never runs, and an unknown host would read as an all-clear
  // (#1280 review, Copilot + Codex).
  requireSkillHost(host);
  const byName = new Map<string, SkillNode[]>();
  for (const node of nodes) {
    // Per host: a name is a directory under ONE host's root, so the same name
    // on a node's Claude and Codex declarations is by design, not a collision.
    const declaration = declaredSkill(node.properties, host);
    // Only an ENABLED declaration claims its name (cor:agt:030:06,
    // D-2026-09-23-C; #1289). A declaration that is off is not exported, so
    // switching an old `foo` off and enabling a new `foo` is a hand-over, not
    // a collision. Excluding it loses no protection: the old node's file, if
    // still on disk, is kept safe by the planner's target-occupied refusal
    // and by `locally-edited`, neither of which reads this function.
    if (declaration === null || !isEnabled(declaration)) continue;
    // Grouped by the RAW stored name, with the trim used ONLY to decide
    // whether there is a name at all (@copilot, PR #1233). Grouping by the
    // trimmed value would make `" x-y "` collide with `"x-y"` — which the
    // reference treats as two distinct names — and would report a collision
    // under a name neither author wrote. Two identically padded names still
    // collide, and the message names them as stored, padding included, so the
    // author can see what to fix.
    if (storedName(declaration) === '') continue;
    const group = byName.get(declaration.name) ?? [];
    group.push(node);
    byName.set(declaration.name, group);
  }

  const out: Finding[] = [];
  // Sorted for a deterministic report — a Map iterates in insertion order,
  // which is the order the caller happened to read the corpus in.
  for (const name of [...byName.keys()].sort()) {
    // Sorted WITHIN the group too (@codex P2, PR #1233). Sorting only the
    // names leaves both the finding order and each message's `others` list
    // following corpus read order, so two equivalent reads of one corpus
    // produce different output — which a `--strict` gate turns into a
    // nondeterministic verdict and a portal turns into a diff that is not a
    // change.
    //
    // A DELIBERATE DIVERGENCE FROM THE REFERENCE, and the only one in this
    // file: Go iterates `byName[name]` in append order and has the same
    // defect. It is reported to hadron-cli rather than fixed there — not my
    // repo — and noted here so a future reader comparing the two does not
    // "restore parity" by removing this line. The parity fixtures agree
    // either way (their inputs are already URN-ordered); the divergence is
    // only observable on an input Go's own suite does not contain, which is
    // precisely why it survived there.
    const group = [...byName.get(name)!].sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
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
