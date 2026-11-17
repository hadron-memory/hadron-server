// Regenerate the post-push-owned half of prisma/post-push-manifest.json from
// the live post-push.sql closure (#434 slice B).
//
//   node scripts/db/gen-post-push-manifest.mjs            rewrite the file
//   node scripts/db/gen-post-push-manifest.mjs --check    exit 1 on drift
//
// The diff-whitelist half is hand-maintained on purpose: it encodes WHY each
// known drift line is acceptable, which only a person can assert. This tool
// never touches it. The completeness test (src/test/postPushManifest.test.ts)
// re-derives the same inventory through the same parser, so a regenerated
// manifest that no longer matches post-push.sql fails CI independently of
// this script.
//
// After regenerating, review the diff: new rows are objects post-push.sql
// newly creates (each needs its why to stay truthful); missing rows are
// objects it no longer creates.

import { writeFileSync, readFileSync } from 'node:fs';
import { postPushInventory } from './postPushInventory.mjs';
import { loadManifest, ManifestError } from './postPushManifest.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const MANIFEST = `${ROOT}prisma/post-push-manifest.json`;
const ENTRY = `${ROOT}prisma/post-push.sql`;

// One GENERIC reason per kind, stamped on every post-push-owned row of that
// kind — generated, not a per-object decision (the hand-reviewed, per-object
// reasons live only in the diff-whitelist rows' `why`).
const KIND_WHY = {
  extension: 'Postgres extension the raw-SQL corpus ensures exists (CREATE EXTENSION); not a Prisma-schema concept.',
  index: 'Index defined in raw SQL; Prisma schema language cannot express this index (partial expression, operator class, or INCLUDE shape).',
  'unique-index': 'Unique index defined in raw SQL; Prisma schema language cannot express this shape (partial or expression-unique).',
  'check-constraint': 'CHECK constraint enforcing a platform invariant; Prisma schema language has no constraints.',
  'foreign-key-constraint': 'Foreign key against a polymorphic owner; Prisma cannot model it against the schema as written.',
  'unique-constraint': 'Table-level UNIQUE constraint defined in raw SQL; not expressible in the Prisma schema as written.',
  'generated-column': 'STORED generated column maintained by Postgres; Prisma schema language does not model generated columns.',
  function: 'Trigger support function (or invariant helper) defined in raw SQL; lives outside the Prisma schema entirely.',
  trigger: 'Trigger wiring an invariant to its table; lives outside the Prisma schema entirely.',
  table: 'Helper table created and owned by the raw-SQL corpus (no Prisma model exists for it).',
  sequence: 'Sequence created by the raw-SQL corpus; no Prisma model exists for it.',
};

const CHECK = process.argv.includes('--check');

const inventory = postPushInventory(ENTRY);
if (inventory.unrecognized.length > 0) {
  console.error(`refusing: ${inventory.unrecognized.length} unrecognized statement(s) in the post-push closure, e.g.`);
  for (const u of inventory.unrecognized.slice(0, 5)) console.error(`  ${u.file}:${u.line}  ${u.sql.slice(0, 100)}`);
  process.exit(2);
}

const rows = inventory.objects
  .map((o) => ({ name: o.name, kind: o.kind, file: o.file.replace(`${ROOT}prisma/`, ''), why: KIND_WHY[o.kind] }))
  .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));

let current;
try {
  current = loadManifest(MANIFEST);
} catch (err) {
  if (!(err instanceof ManifestError)) throw err;
  if (!CHECK) throw err;
  console.error(`manifest failed validation: ${err.message}`);
  process.exit(1);
}

if (CHECK) {
  const have = new Map(current.postPushOwned.map((r) => [`${r.kind}:${r.name}`, r]));
  const want = new Map(rows.map((r) => [`${r.kind}:${r.name}`, r]));
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  if (missing.length || extra.length) {
    for (const k of missing) console.error(`post-push.sql now creates ${k} with no manifest row — regenerate and review`);
    for (const k of extra) console.error(`manifest carries ${k} but post-push.sql no longer creates it — regenerate and review`);
    process.exit(1);
  }
  console.log(`OK — manifest post-push-owned matches the closure (${rows.length} objects)`);
  process.exit(0);
}

const next = {
  note: current.raw.note,
  'diff-whitelist': current.diffWhitelist.map(({ name, kind, why, line }) => ({ name, kind, why, line })),
  'post-push-owned': rows,
};
writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
console.log(`wrote ${rows.length} post-push-owned rows to prisma/post-push-manifest.json (diff-whitelist untouched, ${next['diff-whitelist'].length} rows)`);
