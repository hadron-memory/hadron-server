/**
 * Refresh `scripts/sdl-spec-citations-snapshot.txt` (#4508).
 *
 * The snapshot is the committed inventory of WRITTEN spec nodes that
 * `scripts/check-sdl-spec-citations.mjs` checks every qualified SDL citation
 * against (CI has no corpus access, so it only diffs the file).
 *
 * ## How to refresh (an author step, never CI)
 *
 *     node scripts/refresh-sdl-spec-citation-snapshot.mjs          # rewrite the file
 *     node scripts/refresh-sdl-spec-citation-snapshot.mjs --check  # compare, write nothing
 *
 * Needs the `hadron` CLI, logged in with a token that can read
 * `hadronmemory.com:specs`. Run it when the check says a citation "names no
 * written spec" and the rule has since been written, and in any PR that cites
 * a rule newer than the snapshot. Commit the rewritten file, and name the
 * corpus date from its header in the PR.
 *
 * ## What goes in
 *
 * Every node `hadron spec list` returns whose loc is a whole citation
 * (`cor:<module>:<feature>:<rule>…`), EXCEPT the placeholders
 * `hadron spec describe` reports (reserved citations: a status the server sets; the corpus rules ABOUT them, `cor:spc:020:06` and `:11`, are written specs and stay in): a reserved citation
 * is not a written spec and must fail like a missing one. Superseded nodes stay
 * in (they are written). If either command fails, or `describe` does not carry
 * a `placeholders` list, this script FAILS and leaves the file alone: an
 * inventory built without knowing the placeholders would let a reserved
 * citation pass.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { SPECS_MEMORY, WHOLE_CITATION } from './check-sdl-spec-citations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = join(HERE, 'sdl-spec-citations-snapshot.txt');
export { SPECS_MEMORY };

/**
 * Build the snapshot text from `hadron spec list --json` (an array) and
 * `hadron spec describe --json` (an object with `placeholders`). `today` is the
 * run date, `YYYY-MM-DD`. Pure: the tests drive it with fixtures.
 */
export function buildSnapshot(list, describe, today) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('spec list returned no nodes');
  if (!describe || !Array.isArray(describe.placeholders)) {
    throw new Error('spec describe carries no "placeholders" list; refusing to build an inventory that cannot exclude placeholders');
  }
  const placeholders = new Set(describe.placeholders.map((p) => (typeof p === 'string' ? p : p?.citation)));
  if (placeholders.has(undefined)) throw new Error('spec describe lists a placeholder with no citation');
  const citations = [...new Set(list.map((n) => n?.citation).filter((c) => typeof c === 'string' && WHOLE_CITATION.test(c)))]
    .filter((c) => !placeholders.has(c))
    .sort();
  if (citations.length === 0) throw new Error('no written citation found in the spec list');
  const newest = list.map((n) => n?.updatedAt).filter(Boolean).sort().at(-1) ?? 'unknown';
  return [
    `# Written spec citations in ${SPECS_MEMORY}: what scripts/check-sdl-spec-citations.mjs checks SDL citations against (#4508).`,
    `# Source: hadron spec list + describe, run ${today}; newest node updatedAt ${newest}; ${citations.length} citations; ${placeholders.size} placeholder(s) excluded.`,
    '# GENERATED. Do not edit by hand: node scripts/refresh-sdl-spec-citation-snapshot.mjs (needs the hadron CLI and a token).',
    ...citations,
    '',
  ].join('\n');
}

function hadronJson(...args) {
  try {
    return JSON.parse(execFileSync('hadron', ['spec', ...args, '-m', SPECS_MEMORY, '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error('the `hadron` CLI is not on PATH. Install it and log in with a token that can read ' + SPECS_MEMORY + ', then run this again.');
    }
    throw e;
  }
}

function main() {
  const check = process.argv.includes('--check');
  let text;
  try {
    text = buildSnapshot(hadronJson('list'), hadronJson('describe'), new Date().toISOString().slice(0, 10));
  } catch (e) {
    console.error(`✗ ${String(e?.message ?? e).split('\n')[0]}`);
    process.exit(1);
  }
  // The header's date and newest-updatedAt move on their own; compare the citations only.
  const body = (t) => t.split('\n').filter((l) => l && !l.startsWith('#')).join('\n');
  let current = '';
  let exists = true;
  try { current = readFileSync(SNAPSHOT_FILE, 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
    exists = false; // first run
  }
  if (check) {
    if (!exists) {
      console.error(`✗ snapshot file is missing (${SNAPSHOT_FILE}); run node scripts/refresh-sdl-spec-citation-snapshot.mjs to create it`);
      process.exit(1);
    }
    if (body(current) === body(text)) { console.log('✓ snapshot matches the corpus'); return; }
    console.error('✗ snapshot differs from the corpus; run node scripts/refresh-sdl-spec-citation-snapshot.mjs');
    process.exit(1);
  }
  if (body(current) === body(text)) { console.log('✓ snapshot already current; file left unchanged'); return; }
  writeFileSync(SNAPSHOT_FILE, text);
  console.log(`wrote ${SNAPSHOT_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
