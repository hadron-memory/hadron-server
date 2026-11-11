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
/** The one test file the oracle judges, and the identities of its guarded tests. */
const TARGET = 'server.batchAllocation2774.test.ts';
const PREREQ = /#3872 the test database has the en_US\.UTF-8 collation/;
const GOLDEN = /byte-identical (abstract|all)\/(pk|urn|prefix) output \(edge insertion (forward|reverse)\)/;
/** 2 scopes x 3 forms x 2 insertion orders. */
export const GOLDEN_CASES = 12;

/** Flatten a vitest JSON report to `{ file, name, status, message }` rows. */
export function flatten(report) {
  const rows = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      rows.push({ file: file.name ?? '', name: t.fullName ?? t.title ?? '', status: t.status, message: (t.failureMessages ?? []).join('\n') });
    }
  }
  return rows;
}

/** Files that failed to load or run (no assertion results): a collection or setup error is never a pass. */
function suiteErrors(report) {
  return (report.testResults ?? [])
    .filter(f => f.status === 'failed' && !(f.assertionResults ?? []).length)
    .map(f => `suite error in ${f.name ?? '?'}: ${String(f.message ?? '').slice(0, 160) || 'no message'}`);
}

/**
 * Judge a report. `mode` is 'prerequisite-failure' or 'green'. Only the target file's guarded tests count
 * toward the verdict: an unrelated passing file can never stand in for them, and an empty report, a report
 * without the target file, or a load error fails.
 * @returns {string[]} violations; empty means the oracle is satisfied.
 */
export function evaluateOracle(report, { mode, actual, required, minPassed = 0 }) {
  if (mode !== 'green' && mode !== 'prerequisite-failure') return [`unknown mode ${mode}`];
  const violations = [...suiteErrors(report)];
  const rows = flatten(report);
  const target = rows.filter(r => r.file.endsWith(TARGET));
  if (!target.length) return [...violations, `the report has no results for ${TARGET}`];
  const prereq = target.filter(r => PREREQ.test(r.name));
  const golden = target.filter(r => GOLDEN.test(r.name));
  if (prereq.length !== 1) violations.push(`expected exactly 1 prerequisite test, found ${prereq.length}`);
  if (golden.length !== GOLDEN_CASES) violations.push(`expected ${GOLDEN_CASES} golden cases, found ${golden.length}`);
  const failed = rows.filter(r => r.status === 'failed');
  const passed = rows.filter(r => r.status === 'passed');
  if (mode === 'green') {
    if (report.success !== true) violations.push('the report does not say success: true');
    if (failed.length) violations.push(`${failed.length} test(s) failed on the matching cluster`);
    if (prereq.some(r => r.status !== 'passed')) violations.push('the prerequisite test did not pass');
    const notPassed = golden.filter(r => r.status !== 'passed').length;
    if (notPassed) violations.push(`${notPassed} golden case(s) did not pass`);
    if (passed.length < minPassed) violations.push(`only ${passed.length} passed, need at least ${minPassed}`);
    return violations;
  }
  const opaque = failed.filter(r => OPAQUE.test(r.message));
  if (opaque.length) violations.push(`${opaque.length} opaque golden-hash mismatch(es), expected zero`);
  const named = failed.filter(r => r.message.includes(actual) && r.message.includes(required) && /initdb/.test(r.message));
  if (named.length !== 1) violations.push(`expected exactly 1 named locale-prerequisite failure (actual ${actual}, required ${required}, setup remedy), found ${named.length}`);
  if (failed.length !== 1) violations.push(`expected exactly 1 failed test, found ${failed.length}`);
  if (prereq.some(r => r.status !== 'failed')) violations.push('the prerequisite test is not the failed one');
  const notSkipped = golden.filter(r => r.status !== 'skipped').length;
  if (notSkipped) violations.push(`${notSkipped} golden case(s) were not skipped behind the prerequisite failure`);
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
