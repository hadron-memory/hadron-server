/**
 * SDL-description enumeration gate (#1103).
 *
 * An SDL description is a PUBLISHED surface — it is what the generated GraphQL
 * reference shows a reader — and nothing has ever checked one against the code
 * it describes. Four instances of that drift reached the public reference
 * before this existed; the one that motivated this gate had
 * `createConnectionGrant` telling readers that scopes are a subset of four
 * values while `CONNECTION_GRANT_SCOPES` held five, in a document that named
 * the fifth as a valid scope three fields away. A hand-written docs page then
 * copied the wrong half, which is the tell that matters: reading the reference
 * CAREFULLY produced the worse answer.
 *
 * ## What it checks
 *
 * For each registered set below: any description that spells out **two or more**
 * of its members must spell out **all** of them.
 *
 * ## Why that rule, and not a stricter one
 *
 * Two constraints shaped it, both learned the expensive way on this team:
 *
 *   - **Gate only the default path.** A check that fires on the documented
 *     happy path teaches people to bypass it reflexively. A description that
 *     mentions ONE scope ("Grant scope: drive.read") is documenting a field,
 *     not enumerating a set, and is none of this gate's business — hence the
 *     two-member floor.
 *   - **Watch only what the check consumes.** The members come from importing
 *     the constant, not from a copy: if `CONNECTION_GRANT_SCOPES` gains a
 *     sixth, this fails the same day, with no second list to maintain. A
 *     registry entry that duplicated the members would BE the bug it prevents.
 *
 * ## What it deliberately does NOT catch
 *
 * Descriptions that paraphrase a **formula** rather than a set — the
 * `Session.lastActiveAt` instance, whose description was wrong about precisely
 * the reaped case. There is no second list for a script to read there, so this
 * is a partial mechanism for a partial class, and saying so is better than
 * implying the class is closed.
 *
 * The cheaper alternative remains available and is often better: **do not
 * enumerate in prose at all.** A description that says "see ConnectionGrantScope"
 * cannot drift, and the generated reference already documents that type. This
 * gate exists for the descriptions that do enumerate, not to bless enumerating.
 *
 * Run: pnpm check:sdl-enums   (CI runs this exact command)
 */

import { parse, visit } from 'graphql';
import { pathToFileURL } from 'node:url';
import { typeDefs } from '../src/api/graphql/schema/typeDefs.js';
import { CONNECTION_GRANT_SCOPES } from '../src/lib/emailOperationScopes.js';

/**
 * The sets this gate watches.
 *
 * `members` is IMPORTED, never transcribed — a registry that spelled the values
 * out would be a third list to drift, which is the defect this file exists to
 * catch. Adding a set here is the whole cost of covering it.
 *
 * ## Curated on purpose — do NOT auto-discover const arrays
 *
 * The obvious next move is to scan `src/` for every exported string-literal
 * array and watch them all. That was measured before this shipped, and it is
 * the wrong move: 17 candidate sets produced **154 hits, every one a false
 * positive**, because their members are ordinary English words —
 * `ALL_ENTITY_TYPES` holds `memory` / `node` / `agent`, `WORK_KINDS` holds
 * `issue` / `branch` / `repo`. A description reading "a PR opened, a branch
 * pushed, an issue closed" is prose, not an enumeration, and the gate cannot
 * tell the difference.
 *
 * **The admission criterion is therefore DISTINCTIVE members**: values that do
 * not occur as ordinary words in English prose about the schema.
 * `mail.read` / `drive.read` qualify; `memory` / `issue` never can. A set that
 * fails this test is not covered by any mechanism, and that is the honest
 * outcome — a gate with 154 false positives is one everybody learns to ignore,
 * which costs more than the drift it would have caught.
 */
const WATCHED_SETS = [
  {
    name: 'CONNECTION_GRANT_SCOPES',
    source: 'src/lib/emailOperationScopes.ts',
    members: CONNECTION_GRANT_SCOPES,
  },
];

/**
 * A description "spells out" a member when the value appears as a whole token.
 *
 * The boundary has to separate two cases that look alike, and the first draft
 * of it got the second wrong — caught by running the gate against a CORRECT
 * description, which is the argument for running the command rather than
 * trusting the script:
 *
 *   - `calendar.read` inside `calendar.readonly` is NOT a mention. A real
 *     adjacent value in this codebase, and the false positive a naive
 *     `includes` makes on it is how a gate loses its audience.
 *   - `drive.read.` at the END OF A SENTENCE **is** a mention. Excluding a
 *     following `.` outright — the obvious way to get the first case right —
 *     reported a member as missing from the very description that listed it.
 *
 * So: reject a following word character, and reject a dot only when a word
 * character follows it. A sentence-ending period is not part of the token; a
 * dot continuing into `only` is.
 */
function spellsOut(text, member) {
  const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])(?<!\\w\\.)${escaped}(?![\\w-])(?!\\.\\w)`).test(text);
}

/**
 * Every description in the SDL, with a coordinate a human can navigate to.
 *
 * EXHAUSTIVE BY CONSTRUCTION, not by enumeration (#1123 review, Codex P2). The
 * first version registered visitors for object, input-object and enum
 * definitions plus their fields — which silently skipped descriptions on
 * interfaces, unions, scalars and directives. **A gate that reports success
 * while missing sites is worse than no gate**, and it is precisely the failure
 * this file's docstring warns about elsewhere; a hand-maintained list of node
 * kinds is the same shape of defect as a hand-maintained list of scopes.
 *
 * So: one generic `enter` that records ANY node carrying a description. New
 * description-bearing kinds are covered the day graphql-js adds them, with
 * nothing here to update.
 */
function collectDescriptions(sdl) {
  const out = [];
  let typeName = null;
  visit(parse(sdl), {
    enter(node) {
      // Track the enclosing definition so a field's coordinate is navigable.
      // Covers *TypeDefinition, *TypeExtension and DirectiveDefinition alike,
      // without naming any of them.
      const isDefinition =
        typeof node.kind === 'string' &&
        (node.kind.endsWith('TypeDefinition') ||
          node.kind.endsWith('TypeExtension') ||
          node.kind === 'DirectiveDefinition' ||
          node.kind === 'SchemaDefinition' ||
          node.kind === 'SchemaExtension');
      if (isDefinition) {
        // A schema definition is nameless, so it needs a label of its own —
        // without one it inherited the PREVIOUS type's name and pointed the
        // author at `SomeOtherType.undefined` (#1123 review, Codex P3). The
        // violation was still detected; the coordinate sent them to the wrong
        // file position, which for a diagnostic is most of its value.
        typeName = node.name?.value ?? (node.kind.startsWith('Schema') ? 'schema' : null);
      }

      if (!node.description?.value) return;
      const own = node.name?.value;
      const coord = isDefinition ? (typeName ?? '<anonymous>') : typeName ? `${typeName}.${own}` : (own ?? '<anonymous>');
      out.push({ coord, text: node.description.value });
    },
  });
  return out;
}

/** Descriptions that enumerate part of a watched set. Exported for tests. */
export function findPartialEnumerations(sdl, sets = WATCHED_SETS) {
  const descriptions = collectDescriptions(sdl);
  const violations = [];
  for (const set of sets) {
    for (const { coord, text } of descriptions) {
      const present = set.members.filter((m) => spellsOut(text, m));
      // Fewer than two is a mention, not an enumeration — see the docstring.
      if (present.length < 2) continue;
      const missing = set.members.filter((m) => !present.includes(m));
      if (missing.length > 0) violations.push({ coord, set: set.name, present, missing, text });
    }
  }
  return violations;
}

function main() {
  const violations = findPartialEnumerations(typeDefs);
  if (violations.length === 0) {
    const total = WATCHED_SETS.reduce((n, s) => n + s.members.length, 0);
    console.log(
      `✓ No partial SDL enumerations (${WATCHED_SETS.length} watched set(s), ${total} member(s)).`,
    );
    return;
  }

  console.error(`✗ ${violations.length} SDL description(s) enumerate part of a set:\n`);
  for (const v of violations) {
    console.error(`  ${v.coord} — enumerates ${v.set} but omits: ${v.missing.join(', ')}`);
    console.error(`    lists: ${v.present.join(', ')}`);
    console.error(`    from:  ${v.set} in ${WATCHED_SETS.find((s) => s.name === v.set)?.source}`);
    console.error(`    text:  ${v.text.replace(/\s+/g, ' ').trim().slice(0, 160)}\n`);
  }
  console.error(
    '  Two fixes, and the second is usually better:\n' +
      '    1. Add the missing member(s) to the description.\n' +
      '    2. Stop enumerating — name the TYPE instead ("see ConnectionGrantScope").\n' +
      '       A description that does not spell out a set cannot drift from it, and\n' +
      '       the generated reference already documents the type.\n',
  );
  process.exit(1);
}

// Executed directly (CI / pnpm check:sdl-enums) — not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
