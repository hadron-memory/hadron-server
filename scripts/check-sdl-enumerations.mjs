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
 * For each registered set below: a description in its scope that spells out
 * **two or more** members must spell out **all** of them. A curated pattern
 * promising a closed list is checked even with fewer surviving members.
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
import { EMAIL_PROVIDER_KEYS } from '../src/lib/emailClient.js';
import { GOVERNED_ROLES } from '../src/lib/governedRole.js';
import { WORK_KINDS } from '../src/lib/workRef.js';
import { VALID_SCOPE_PREFIXES, VALID_BUILTINS } from '../src/lib/edge-conditions/operators.js';

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
 * fails this test cannot be watched globally. An explicit coordinate allowlist
 * may watch a description that promises a closed enumeration, without treating
 * unrelated prose as a list. Without that scoping it is not covered, and that is the honest
 * outcome — a gate with 154 false positives is one everybody learns to ignore,
 * which costs more than the drift it would have caught.
 */
const WATCHED_SETS = [
  {
    // #2302: ordinary words are admissible only at explicitly enumerating
    // coordinates. Never scan unrelated prose for review/spec/issue/branch.
    name: 'GOVERNED_ROLES', source: 'src/lib/governedRole.ts', members: GOVERNED_ROLES,
    coordinates: ['Node.role', 'CreateNodeInput.role'],
  },
  {
    name: 'WORK_KINDS', source: 'src/lib/workRef.ts', members: WORK_KINDS,
    coordinates: ['Query.teamWorkItems', 'Mutation.recordTeamWork'],
    // The canonical-ref examples also contain 'repo'; only the promised kind
    // list supplies membership evidence, not unrelated words in the same block.
    enumerationPattern: /kind\s+must\s+be\s+one\s+of\s+([^.;]+)/i,
  },
  {
    name: 'CONNECTION_GRANT_SCOPES',
    source: 'src/lib/emailOperationScopes.ts',
    members: CONNECTION_GRANT_SCOPES,
  },
  {
    // #1232. Added because a published description got this wrong for three
    // providers: `ExchangeConnection.provider` said "'ms-exchange' today" long
    // after gmail, google-cal and google-drive were dispatching. Admissible by
    // this file's own criterion — the keys are hyphenated identifiers, never
    // ordinary English words about the schema.
    //
    // Scope note, so nobody reads more into this than it does: this pins ONE
    // of the eight stale claims #1232 found. The others — a count ("four-way
    // memory typology"), a dropped FK, an over-narrow auth rule — have no
    // second list for a script to read, and `MemoryClass` itself is
    // INADMISSIBLE here (its members are `app` / `personal` / `private` /
    // `group`, ordinary words that would produce exactly the false positives
    // this registry is curated to avoid).
    name: 'EMAIL_PROVIDER_KEYS',
    source: 'src/lib/emailClient.ts',
    members: EMAIL_PROVIDER_KEYS,
  },
  {
    // #1246. `Edge.condition` enumerated these and got it wrong in two ways at
    // once: it said "the FIVE variable scopes" over a set of four, and folded
    // the time builtins in as the fifth — a count error and a category error in
    // one sentence. They are separate constants with separate rejection paths
    // (UNKNOWN_SCOPE applies to prefixes; a builtin is a whole reference).
    //
    // Admissible by this file's criterion: every member carries a trailing dot
    // or parens, so none can occur as an ordinary English word in prose about
    // the schema. Watched as TWO sets rather than one for the same reason the
    // description was wrong — merging them here would encode the conflation
    // this entry exists to catch.
    name: 'VALID_SCOPE_PREFIXES',
    source: 'src/lib/edge-conditions/operators.ts',
    members: VALID_SCOPE_PREFIXES,
    // The phrase the count attaches to. Declaring it turns on the count check
    // for THIS set only — "the five variable scopes" over a set of four is the
    // defect #1246 fixed, and completeness alone passed it.
    countNoun: 'variable scopes?',
  },
  {
    name: 'VALID_BUILTINS',
    source: 'src/lib/edge-conditions/operators.ts',
    members: VALID_BUILTINS,
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
  // The enclosing FIELD, so an argument's coordinate names it. Without this,
  // `Mutation.foo(scopes:)` and `Mutation.bar(scopes:)` both reported
  // `Mutation.scopes` — one coordinate for two definitions, which is a
  // diagnostic that cannot be acted on (#1123 review, Codex P3).
  let fieldName = null;
  visit(parse(sdl), {
    leave(node) {
      if (node.kind === 'FieldDefinition') fieldName = null;
    },
    enter(node) {
      if (node.kind === 'FieldDefinition') fieldName = node.name?.value ?? null;
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
      // An InputValueDefinition is either a field ARGUMENT (inside a field) or
      // an input-object field (not). Only the first needs the field name.
      const isArgument = node.kind === 'InputValueDefinition' && fieldName !== null;
      const coord = isDefinition
        ? (typeName ?? '<anonymous>')
        : isArgument
          ? `${typeName}.${fieldName}(${own}:)`
          : typeName
            ? `${typeName}.${own}`
            : (own ?? '<anonymous>');
      out.push({ coord, text: node.description.value });
    },
  });
  return out;
}

/** Descriptions that enumerate part of a watched set. Exported for tests. */
/** Number words a description might state a set's size with. */
const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
]);

/**
 * A description that ENUMERATES a set completely and also states a COUNT must
 * state the right one at least once.
 *
 * Completeness alone does not catch the defect this gate was extended for
 * (@codex, PR #1256). `Edge.condition` said "the FIVE variable scopes
 * (memory.*, chat.*, agent.*, message.data.*, now()/today())" — which spells
 * out every member of BOTH watched sets, so the completeness check passes it.
 * The error was the number and the conflation, not an omission. Verified by
 * restoring the original sentence and watching the gate go green.
 *
 * OPT-IN per set, via `countNoun`, and that is load-bearing. The first version
 * scanned every number word in the description and produced TWO false positives
 * immediately: `ExchangeConnection.provider` says "three providers out of date"
 * in a historical note, and `Edge.condition` states "FOUR variable scopes" while
 * also enumerating the two builtins — a number belonging to the OTHER set. A
 * description may legitimately contain numbers about anything.
 *
 * So the check fires only where a registry entry names the noun phrase its
 * count attaches to, and only for a number word immediately preceding it. A set
 * with no `countNoun` gets completeness checking only — which is the honest
 * default, since most enumerations never state a size.
 */
function statesAWrongCount(text, size, countNoun) {
  if (!countNoun) return false;
  const near = new RegExp(
    `\\b(one|two|three|four|five|six|seven|eight|nine|ten)\\b[\\s\\S]{0,12}?${countNoun}`,
    'i',
  );
  const m = near.exec(text);
  if (!m) return false;
  return NUMBER_WORDS.get(m[1].toLowerCase()) !== size;
}

export function findPartialEnumerations(sdl, sets = WATCHED_SETS) {
  const descriptions = collectDescriptions(sdl);
  const violations = [];
  for (const set of sets) {
    for (const { coord, text } of descriptions) {
      if (set.coordinates && !set.coordinates.includes(coord)) continue;
      const enumeration = set.enumerationPattern ? set.enumerationPattern.exec(text)?.[1] : text;
      if (enumeration === undefined) continue;
      const present = set.members.filter((m) => spellsOut(enumeration, m));
      // Without a promised-list pattern, fewer than two is a mention, not
      // an enumeration. A scoped explicit list remains checkable with one.
      if (present.length < 2 && !set.enumerationPattern) continue;
      const missing = set.members.filter((m) => !present.includes(m));
      if (missing.length > 0) {
        violations.push({ coord, set: set.name, present, missing, text });
        continue;
      }
      // Complete — but is the COUNT it claims the set's actual size?
      if (statesAWrongCount(text, set.members.length, set.countNoun)) {
        violations.push({
          coord, set: set.name, present, missing: [],
          wrongCount: set.members.length, text,
        });
      }
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
    if (v.missing.length === 0) {
      console.error(
        `  ${v.coord} — enumerates all ${v.wrongCount} of ${v.set}, but the count it states is not ${v.wrongCount}`,
      );
    } else {
      console.error(`  ${v.coord} — enumerates ${v.set} but omits: ${v.missing.join(', ')}`);
    }
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
