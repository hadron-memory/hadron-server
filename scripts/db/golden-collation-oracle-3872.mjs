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

/**
 * Suite and report errors, judged independently of how many assertions a file recorded: a file whose reporter
 * message is non-empty (a collection, hook or teardown error), a failed file with no failed assertion, and a
 * report that counts a runtime-error suite. Only failed ASSERTIONS are judged elsewhere, so a suite that records
 * the expected assertions and then fails in teardown is still refused.
 */
function suiteErrors(report) {
  const errors = (report.testResults ?? []).flatMap(f => {
    const asserts = f.assertionResults ?? [];
    const out = [];
    if (String(f.message ?? '').trim()) out.push(`suite error in ${f.name ?? '?'}: ${String(f.message).trim().slice(0, 160)}`);
    else if (f.status === 'failed' && !asserts.some(t => t.status === 'failed')) out.push(`suite error in ${f.name ?? '?'}: failed with no failed assertion`);
    return out;
  });
  if (Number(report.numRuntimeErrorTestSuites ?? 0) > 0) errors.push(`the report counts ${report.numRuntimeErrorTestSuites} runtime-error suite(s)`);
  return errors;
}

/** The 12 golden identities, each required exactly once. */
const EXPECTED_GOLDEN = ['abstract', 'all'].flatMap(sc => ['pk', 'urn', 'prefix'].flatMap(f => ['forward', 'reverse'].map(o => `${sc}/${f}/${o}`)));
function goldenIdentityViolations(golden) {
  const seen = new Map();
  for (const r of golden) {
    const m = GOLDEN.exec(r.name);
    const key = m ? `${m[1]}/${m[2]}/${m[3]}` : r.name;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const out = [];
  const missing = EXPECTED_GOLDEN.filter(k => !seen.has(k));
  const repeated = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  const unexpected = [...seen.keys()].filter(k => !EXPECTED_GOLDEN.includes(k));
  if (missing.length) out.push(`golden cases missing: ${missing.join(', ')}`);
  if (repeated.length) out.push(`golden cases repeated: ${repeated.join(', ')}`);
  if (unexpected.length) out.push(`unexpected golden cases: ${unexpected.join(', ')}`);
  return out;
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
  violations.push(...goldenIdentityViolations(golden));
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
