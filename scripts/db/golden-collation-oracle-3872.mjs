#!/usr/bin/env node
/**
 * #3872 regression oracle for the batch-projection golden's locale prerequisite.
 *
 * Reads a vitest `--reporter=json` report of `src/mcp/server.batchAllocation2774.test.ts`
 * (plus any files run beside it) and judges it against the reporter's acceptance:
 *
 *   --expect-prerequisite-failure  (run on a non-matching cluster, e.g. C.UTF-8)
 *       exactly ONE failed test; its message names the actual and the required collation
 *       and the setup remedy; and ZERO failures are opaque golden-hash mismatches.
 *   --expect-green [--min-passed N]  (run on the matching en_US.UTF-8 cluster)
 *       zero failed tests and at least N passed ones.
 *
 * Exit 0 = the report satisfies the mode, 1 = it does not (violations on stderr), 2 = usage.
 * This is test tooling only: it never opens a database and never reads a hash.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPAQUE = /response hash mismatch|expected '[0-9a-f]{16,}/i;

/** Flatten a vitest JSON report to `{ name, status, message }` rows. */
export function flatten(report) {
  const rows = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      rows.push({ name: t.fullName ?? t.title ?? '', status: t.status, message: (t.failureMessages ?? []).join('\n') });
    }
  }
  return rows;
}

/**
 * Judge a report. `mode` is 'prerequisite-failure' or 'green'.
 * @returns {string[]} violations; empty means the oracle is satisfied.
 */
export function evaluateOracle(report, { mode, actual, required, minPassed = 0 }) {
  const rows = flatten(report);
  const failed = rows.filter(r => r.status === 'failed');
  const passed = rows.filter(r => r.status === 'passed');
  const violations = [];
  if (mode === 'green') {
    if (failed.length) violations.push(`${failed.length} test(s) failed on the matching cluster`);
    if (passed.length < minPassed) violations.push(`only ${passed.length} passed, need at least ${minPassed}`);
    return violations;
  }
  if (mode !== 'prerequisite-failure') return [`unknown mode ${mode}`];
  const opaque = failed.filter(r => OPAQUE.test(r.message));
  if (opaque.length) violations.push(`${opaque.length} opaque golden-hash mismatch(es), expected zero`);
  const named = failed.filter(r => r.message.includes(actual) && r.message.includes(required) && /initdb/.test(r.message));
  if (named.length !== 1) violations.push(`expected exactly 1 named locale-prerequisite failure (actual ${actual}, required ${required}, setup remedy), found ${named.length}`);
  if (failed.length !== 1) violations.push(`expected exactly 1 failed test, found ${failed.length}`);
  return violations;
}

function main(argv) {
  const file = argv[0];
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const mode = argv.includes('--expect-green') ? 'green' : argv.includes('--expect-prerequisite-failure') ? 'prerequisite-failure' : undefined;
  if (!file || !mode) { console.error('usage: golden-collation-oracle-3872.mjs <vitest.json> (--expect-green [--min-passed N] | --expect-prerequisite-failure --actual C.UTF-8 --required en_US.UTF-8)'); return 2; }
  const violations = evaluateOracle(JSON.parse(readFileSync(file, 'utf8')), {
    mode, actual: flag('--actual') ?? 'C.UTF-8', required: flag('--required') ?? 'en_US.UTF-8', minPassed: Number(flag('--min-passed') ?? 0),
  });
  if (violations.length) { for (const v of violations) console.error(`oracle: ${v}`); return 1; }
  console.log(`oracle: ${mode} satisfied`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
