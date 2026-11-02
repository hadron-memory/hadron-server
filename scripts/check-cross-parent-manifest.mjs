#!/usr/bin/env node
/**
 * #3221 (#1522 S3) - the fail-closed manifest of cross-parent object fields.
 *
 * THE CLASS. #1521 and #1522 found the #552 hole one field at a time: a GraphQL
 * field that returns ANOTHER entity's object hands the caller that entity's
 * field resolvers, which assume the outer query already authorized them. Nothing
 * stopped the next such field from shipping ungated, because nothing knew which
 * fields return another entity or why each one is safe.
 *
 * WHAT THIS PROVES. CLASSIFICATION, NOT AUTHORIZATION. The walk finds every
 * in-scope field and refuses to pass until each carries a reasoned entry in
 * `scripts/cross-parent-manifest.json`. Authorization is carried by the
 * `child-gated` tests the entries name and by the reading of the
 * `parent-implies-child` entries (a §10 seat reads those). A green walk never
 * says a field is safe; it says somebody had to say why.
 *
 * WHAT "IN SCOPE" MEANS (the definition the gate asked the PR to state):
 *   an object-returning field of a NON-ROOT object type whose unwrapped return
 *   type is a different object type that is not listed in `nonEntityTypes`.
 *   - Query / Mutation / Subscription fields are out of scope: nothing resolved
 *     an outer entity before them, so there is no parent gate to lean on; each
 *     is its own root resolver's gate (cor:acl:110:02 is about NESTED fields).
 *   - A self-typed field (`Node.parent: Node`) is out of scope: same type, same
 *     read.
 *   - `*Page.items` IS in scope: it is classified like the list it pages. The
 *     page TYPE is an envelope (a `nonEntityTypes` row); its items are not.
 *   - FAIL CLOSED: a type missing from `nonEntityTypes` counts as an entity, so
 *     a NEW object type's fields all fail until someone either classifies them
 *     or states, in a reviewed row, that the type is an envelope or a value
 *     type with no read gate of its own. The table is the audited surface: a
 *     row that is stale (type gone) or has no kind also fails.
 *
 * THE FIVE ENTRY CLASSES (each entry also records `target`, the return type, so
 * a field whose type changes under an old entry fails):
 *   self-gated            { resolver: 'path::name', gate: 'sharedGateName' }
 *                         the file exists and contains both names.
 *   child-gated           { test: 'path::exact test title' }
 *                         the file exists and contains the title; the test goes
 *                         red if the gate is removed.
 *   parent-implies-child  { audience, spec: 'cor:xxx:000:00' | resolver: 'path::name' }
 *                         names the parent's audience and the rule or code that
 *                         proves it.
 *   closed-projection     { projection: <target>, why }
 *                         a separate type carrying nothing the child's own read
 *                         would withhold (cor:acl:110:02's third way).
 *   open                  { evidence: names the issue (#N) or evidence required }
 *                         unresolved; never a silent pass.
 *
 * Run (CI: graphql-sdl-parse.yml, same job as check-graphql-sdl.mjs):
 *   pnpm tsx scripts/check-cross-parent-manifest.mjs [--manifest <file>]
 * Exits 0 when complete, 1 otherwise. The helpers are exported so the test can
 * prove the gate FAILS.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, Kind } from 'graphql';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MANIFEST_PATH = join(HERE, 'scripts', 'cross-parent-manifest.json');
export const ROOT_TYPES = Object.freeze(['Query', 'Mutation', 'Subscription']);
export const CLASSES = Object.freeze(['self-gated', 'child-gated', 'parent-implies-child', 'closed-projection', 'open']);
const NON_ENTITY_KINDS = Object.freeze(['envelope', 'value']);
const SPEC_CITATION = /^cor:[a-z]{3}:\d{3}(?::\d{2})?$/;

const unwrap = t => (t.kind === Kind.NAMED_TYPE ? t.name.value : unwrap(t.type));

/** Every named type definition in the SDL, by kind of interest. */
function typesOf(sdl) {
  const doc = parse(sdl);
  const objectLike = new Map(); // object / interface type name -> fields
  const targets = new Set(); // names a field may return as an "object"
  const all = new Set();
  for (const def of doc.definitions) {
    const name = def.name?.value;
    if (name) all.add(name);
    if (
      def.kind === Kind.OBJECT_TYPE_DEFINITION ||
      def.kind === Kind.OBJECT_TYPE_EXTENSION ||
      def.kind === Kind.INTERFACE_TYPE_DEFINITION ||
      def.kind === Kind.INTERFACE_TYPE_EXTENSION
    ) {
      objectLike.set(name, [...(objectLike.get(name) ?? []), ...(def.fields ?? [])]);
      targets.add(name);
    } else if (def.kind === Kind.UNION_TYPE_DEFINITION || def.kind === Kind.UNION_TYPE_EXTENSION) {
      targets.add(name); // a union is at least as entity-bearing as the objects it names
    }
  }
  return { objectLike, targets, all };
}

/**
 * The in-scope field set. `nonEntityTypes` is the list of type NAMES excluded
 * as targets; everything else that is an object, interface or union is in.
 */
export function walkCrossParentFields(sdl, nonEntityTypes) {
  const { objectLike, targets } = typesOf(sdl);
  const skip = new Set(nonEntityTypes);
  const out = [];
  for (const [parent, fields] of objectLike) {
    if (ROOT_TYPES.includes(parent)) continue;
    for (const f of fields) {
      const target = unwrap(f.type);
      if (!targets.has(target) || target === parent || skip.has(target)) continue;
      out.push({ coord: `${parent}.${f.name.value}`, parent, field: f.name.value, target });
    }
  }
  return out;
}

const blank = v => typeof v !== 'string' || v.trim() === '';

/** `path::name`: the file exists under root and contains `name` as text. */
function checkRef(root, ref, what, coord, problems) {
  if (blank(ref) || !ref.includes('::')) {
    problems.push(`${coord}: ${what} must be 'path::name'`);
    return;
  }
  const at = ref.indexOf('::');
  const file = ref.slice(0, at);
  const name = ref.slice(at + 2);
  const full = join(root, file);
  if (blank(name) || !existsSync(full)) {
    problems.push(`${coord}: ${what} names ${file}, which does not exist`);
    return;
  }
  if (!readFileSync(full, 'utf8').includes(name)) {
    problems.push(`${coord}: ${what} names "${name}", which ${file} does not contain`);
  }
}

function checkEntry(coord, entry, found, root, problems) {
  if (entry === null || typeof entry !== 'object') {
    problems.push(`${coord}: entry has no class (one of ${CLASSES.join(', ')})`);
    return;
  }
  if (blank(entry.target)) problems.push(`${coord}: entry has no recorded target (expected ${found.target})`);
  else if (entry.target !== found.target) {
    problems.push(`${coord}: entry records target ${entry.target} but the schema returns ${found.target}`);
  }
  if (!CLASSES.includes(entry.class)) {
    problems.push(`${coord}: entry has no valid class (one of ${CLASSES.join(', ')})`);
    return;
  }
  switch (entry.class) {
    case 'self-gated':
      checkRef(root, entry.resolver, 'resolver', coord, problems);
      if (blank(entry.gate)) problems.push(`${coord}: self-gated needs the shared gate it calls`);
      else if (!blank(entry.resolver) && entry.resolver.includes('::')) {
        const full = join(root, entry.resolver.slice(0, entry.resolver.indexOf('::')));
        if (existsSync(full) && !readFileSync(full, 'utf8').includes(entry.gate)) {
          problems.push(`${coord}: gate "${entry.gate}" is not in ${entry.resolver.slice(0, entry.resolver.indexOf('::'))}`);
        }
      }
      break;
    case 'child-gated':
      if (blank(entry.test)) problems.push(`${coord}: child-gated needs the runtime test that goes red if the gate is removed (test: 'path::title')`);
      else checkRef(root, entry.test, 'test', coord, problems);
      break;
    case 'parent-implies-child':
      if (blank(entry.audience)) problems.push(`${coord}: parent-implies-child needs the parent's audience`);
      if (blank(entry.spec) && blank(entry.resolver)) {
        problems.push(`${coord}: parent-implies-child needs a spec citation or the resolver that proves it`);
      } else {
        if (!blank(entry.spec) && !SPEC_CITATION.test(entry.spec)) problems.push(`${coord}: spec "${entry.spec}" is not a citation like cor:acl:090:02`);
        if (!blank(entry.resolver)) checkRef(root, entry.resolver, 'resolver', coord, problems);
      }
      if (!blank(entry.maskingTest)) checkRef(root, entry.maskingTest, 'maskingTest', coord, problems);
      break;
    case 'closed-projection':
      if (blank(entry.projection)) problems.push(`${coord}: closed-projection needs the projection type`);
      else if (entry.projection !== found.target) problems.push(`${coord}: projection ${entry.projection} is not the returned type ${found.target}`);
      if (blank(entry.why)) problems.push(`${coord}: closed-projection needs why it carries no withheld field (why)`);
      break;
    case 'open':
      if (blank(entry.evidence)) problems.push(`${coord}: open needs the evidence requirement (evidence)`);
      else if (!/#\d+|issue|private|differential test/i.test(entry.evidence)) {
        problems.push(`${coord}: open evidence must name the issue (#N) or the evidence required`);
      }
      break;
  }
}

/**
 * The whole check. `manifest` is the parsed JSON (or undefined when missing).
 * `root` resolves the paths entries cite.
 */
export function checkManifest({ sdl, manifest, root = HERE }) {
  const problems = [];
  if (manifest === undefined || manifest === null || typeof manifest !== 'object') {
    problems.push('no manifest: scripts/cross-parent-manifest.json is missing or not an object');
    return { problems, inScope: 0 };
  }
  const nonEntity = manifest.nonEntityTypes ?? {};
  const entries = manifest.entries ?? {};
  const { all } = typesOf(sdl);

  for (const [type, kind] of Object.entries(nonEntity)) {
    if (!all.has(type)) problems.push(`nonEntityTypes: ${type} no longer exists in the schema (stale row)`);
    if (!NON_ENTITY_KINDS.includes(kind)) problems.push(`nonEntityTypes: ${type} must be an envelope or a value type, got "${kind}"`);
  }

  const walked = walkCrossParentFields(sdl, Object.keys(nonEntity));
  const byCoord = new Map(walked.map(f => [f.coord, f]));
  for (const f of walked) {
    if (!(f.coord in entries)) {
      problems.push(`${f.coord}: no manifest entry (returns ${f.target} from ${f.parent}); classify it in scripts/cross-parent-manifest.json`);
    }
  }
  for (const coord of Object.keys(entries)) {
    const found = byCoord.get(coord);
    if (!found) {
      problems.push(`${coord}: manifest entry for a field that is no longer in scope (stale: the field is gone, root, self-typed or returns a non-entity type)`);
      continue;
    }
    checkEntry(coord, entries[coord], found, root, problems);
  }
  return { problems, inScope: walked.length };
}

async function main(argv) {
  const at = argv.indexOf('--manifest');
  const manifestFile = at === -1 ? MANIFEST_PATH : resolve(argv[at + 1] ?? '');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    manifest = undefined;
  }
  const { typeDefs } = await import('../src/api/graphql/schema/typeDefs.js');
  const { problems, inScope } = checkManifest({ sdl: typeDefs, manifest });
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`\n✗ cross-parent manifest: ${problems.length} problem(s) across ${inScope} in-scope field(s).`);
    return 1;
  }
  console.log(`✓ cross-parent manifest complete: ${inScope} in-scope field(s) classified.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
