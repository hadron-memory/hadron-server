/**
 * #3872: the batch-projection golden hashes (src/mcp/server.batchAllocation2774.test.ts) assume the
 * en_US.UTF-8 libc database collation. These pins cover the guard that enforces that prerequisite and
 * the oracle that judges a run on a non-matching cluster. No product ordering and no hash is touched.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import {
  GoldenCollationError, REQUIRED_GOLDEN_COLLATION, assertGoldenCollation, collationDiagnostic, judgeCollation, readDatabaseCollation,
} from './goldenCollation3872.js';
// @ts-expect-error plain .mjs tooling, no declaration file
import { evaluateOracle } from '../../scripts/db/golden-collation-oracle-3872.mjs';

const fake = (impl: () => Promise<unknown>) => ({ $queryRaw: impl }) as never;

describe('#3872 judgeCollation', () => {
  it('requires exactly en_US.UTF-8 on the libc provider', () => {
    expect(REQUIRED_GOLDEN_COLLATION).toBe('en_US.UTF-8');
    expect(judgeCollation({ collate: 'en_US.UTF-8', provider: 'c' }).kind).toBe('match');
  });
  it('admits the one other spelling with evidence: the CI cluster reports en_US.utf8 (libc)', () => {
    expect(judgeCollation({ collate: 'en_US.utf8', provider: 'c' }).kind).toBe('match');
  });
  it.each([
    ['C.UTF-8 libc', { collate: 'C.UTF-8', provider: 'c' }],
    ['unadmitted spelling EN_US.UTF-8', { collate: 'EN_US.UTF-8', provider: 'c' }],
    ['unadmitted spelling en_US.UTF8', { collate: 'en_US.UTF8', provider: 'c' }],
    ['another English locale', { collate: 'en_GB.UTF-8', provider: 'c' }],
    ['en_US.utf8 on the ICU provider', { collate: 'en_US.utf8', provider: 'i' }],
    ['right name, ICU provider', { collate: 'en_US.UTF-8', provider: 'i' }],
    ['right name, builtin provider', { collate: 'en_US.UTF-8', provider: 'b' }],
  ])('refuses %s as a known mismatch, never as equivalent', (_label, observed) => {
    expect(judgeCollation(observed).kind).toBe('mismatch');
  });
  it.each([
    ['no row', null],
    ['null collation', { collate: null, provider: 'c' }],
    ['empty collation', { collate: '', provider: 'c' }],
    ['null provider', { collate: 'en_US.UTF-8', provider: null }],
  ])('treats %s as unknown, not as a match', (_label, observed) => {
    expect(judgeCollation(observed).kind).toBe('unknown');
  });
  it('names the actual and the required collation, the provider and the setup remedy', () => {
    const text = collationDiagnostic(judgeCollation({ collate: 'C.UTF-8', provider: 'c' }));
    expect(text).toContain('C.UTF-8');
    expect(text).toContain('en_US.UTF-8');
    expect(text).toMatch(/libc/);
    expect(text).toMatch(/initdb .*--locale=en_US\.UTF-8/);
    expect(text).toMatch(/never (change|alter)/i);
  });
});

describe('#3872 assertGoldenCollation inspects the connected database', () => {
  it('reads the live database metadata, not an environment variable', async () => {
    const observed = await readDatabaseCollation(db);
    expect(observed?.provider).toMatch(/^[cib]$/);
    // Independent of the metadata under test: how this database actually sorts. libc en_US.UTF-8 ignores
    // punctuation and case at the first level; C/POSIX collations compare bytes.
    const [{ sorted }] = await db.$queryRaw<Array<{ sorted: string[] }>>`
      SELECT array_agg(x ORDER BY x) AS sorted FROM unnest(ARRAY['a', 'B', '_a']) AS x`;
    // Assert only the two configurations whose behavior is established; any other locale is left to the
    // explicit mismatch diagnostic rather than adding a second failure here.
    const collate = observed?.collate ?? '';
    if (/^(C|POSIX)(\.|$)/.test(collate)) expect(sorted).toEqual(['B', '_a', 'a']);
    else if (collate === 'en_US.UTF-8' || collate === 'en_US.utf8') expect(sorted).toEqual(['_a', 'a', 'B']);
  });
  it('throws a named mismatch error carrying the observed collation', async () => {
    const err = await assertGoldenCollation(fake(async () => [{ collate: 'C.UTF-8', provider: 'c' }])).catch(e => e);
    expect(err).toBeInstanceOf(GoldenCollationError);
    expect(err.code).toBe('LOCALE_PREREQUISITE');
    expect(err.message).toContain('C.UTF-8');
  });
  it('passes on the matching collation', async () => {
    await expect(assertGoldenCollation(fake(async () => [{ collate: 'en_US.UTF-8', provider: 'c' }]))).resolves.toBeUndefined();
  });
  it('fails clearly on an unreadable collation instead of bypassing', async () => {
    const err = await assertGoldenCollation(fake(async () => [])).catch(e => e);
    expect(err).toBeInstanceOf(GoldenCollationError);
    expect(err.code).toBe('LOCALE_UNKNOWN');
  });
  it('does not mislabel a failed query as a known locale mismatch', async () => {
    const err = await assertGoldenCollation(fake(async () => { throw new Error('connection reset'); })).catch(e => e);
    expect(err).toBeInstanceOf(GoldenCollationError);
    expect(err.code).toBe('LOCALE_UNREADABLE');
    expect(err.message).toContain('connection reset');
    expect(err.message).not.toMatch(/reports collation/);
  });
});

describe('#3872 oracle', () => {
  const FILE = '/w/src/mcp/server.batchAllocation2774.test.ts';
  const PREREQ = '#2774 golden projection (requires the en_US.UTF-8 database collation, #3872) #3872 the test database has the en_US.UTF-8 collation the golden hashes assume';
  const goldenName = (i: number) => `#2774 golden projection (requires the en_US.UTF-8 database collation, #3872) #2774 bounds endpoint/root payloads with byte-identical ${i % 2 ? 'all' : 'abstract'}/${['pk', 'urn', 'prefix'][i % 3]} output (edge insertion ${i < 6 ? 'forward' : 'reverse'})`;
  const named = 'GoldenCollationError: LOCALE_PREREQUISITE: golden hashes need en_US.UTF-8, database is C.UTF-8; initdb --locale=en_US.UTF-8';
  const row = (fullName: string, status: string, message = '') => ({ fullName, status, failureMessages: message ? [message] : [] });
  const goldens = (status: string, message = '') => Array.from({ length: 12 }, (_, i) => row(goldenName(i), status, message));
  const file = (rows: unknown[], extra: object = {}) => ({ name: FILE, status: 'passed', assertionResults: rows, ...extra });
  const prereqOpts = { mode: 'prerequisite-failure', actual: 'C.UTF-8', required: 'en_US.UTF-8' };
  const greenOpts = { mode: 'green', minPassed: 13 };
  const green = () => ({ success: true, testResults: [file([row(PREREQ, 'passed'), ...goldens('passed')])] });
  const mismatch = () => ({ success: false, testResults: [file([row(PREREQ, 'failed', named), ...goldens('skipped')], { status: 'failed' })] });

  it('accepts one named failure with the 12 golden cases skipped behind it', () => {
    expect(evaluateOracle(mismatch(), prereqOpts)).toEqual([]);
  });
  it('rejects the pre-fix state: twelve opaque hash mismatches and no named failure', () => {
    const opaque = "AssertionError: response hash mismatch: node n, field Referenced by: expected '4beced6f140838116be795a5d4b0c23b0affb8e4830f89249e8dba03dc216f5f'";
    const report = { success: false, testResults: [file([...goldens('failed', opaque)], { status: 'failed' })] };
    const v = evaluateOracle(report, prereqOpts).join('\n');
    expect(v).toMatch(/12 opaque/);
    expect(v).toMatch(/exactly 1 named/);
  });
  it('rejects a repeated named failure, golden cases that ran, and missing or extra golden cases', () => {
    const twice = { success: false, testResults: [file([row(PREREQ, 'failed', named), ...goldens('failed', named)], { status: 'failed' })] };
    expect(evaluateOracle(twice, prereqOpts).join('\n')).toMatch(/found 13|exactly 1 failed/);
    const ran = { success: false, testResults: [file([row(PREREQ, 'failed', named), ...goldens('passed')], { status: 'failed' })] };
    expect(evaluateOracle(ran, prereqOpts).join('\n')).toMatch(/12 golden case\(s\) were not skipped/);
    const missing = { success: false, testResults: [file([row(PREREQ, 'failed', named), ...goldens('skipped').slice(0, 11)], { status: 'failed' })] };
    expect(evaluateOracle(missing, prereqOpts).join('\n')).toMatch(/golden cases missing: abstract\/pk\/reverse|golden cases missing/);
  });
  it('rejects twelve copies of one golden identity, and one repeated beside a missing one', () => {
    const copies = { success: false, testResults: [file([row(PREREQ, 'failed', named), ...Array.from({ length: 12 }, () => row(goldenName(0), 'skipped'))], { status: 'failed' })] };
    const v = evaluateOracle(copies, prereqOpts).join('\n');
    expect(v).toMatch(/golden cases missing/);
    expect(v).toMatch(/golden cases repeated: abstract\/pk\/forward x12/);
    const swapped = [...goldens('skipped').slice(0, 11), row(goldenName(0), 'skipped')];
    const w = evaluateOracle({ success: false, testResults: [file([row(PREREQ, 'failed', named), ...swapped], { status: 'failed' })] }, prereqOpts).join('\n');
    expect(w).toMatch(/missing/);
    expect(w).toMatch(/repeated/);
  });
  it('rejects a suite or report error that sits beside the expected assertions', () => {
    const teardown = { success: false, testResults: [file([row(PREREQ, 'failed', named), ...goldens('skipped')], { status: 'failed', message: 'afterAll hook failed: connection terminated' })] };
    expect(evaluateOracle(teardown, prereqOpts).join('\n')).toMatch(/suite error.*afterAll hook failed/);
    const green2 = { ...green(), testResults: [file([row(PREREQ, 'passed'), ...goldens('passed')], { message: 'teardown timed out' })] };
    expect(evaluateOracle(green2, greenOpts).join('\n')).toMatch(/suite error/);
    expect(evaluateOracle({ ...mismatch(), numRuntimeErrorTestSuites: 1 }, prereqOpts).join('\n')).toMatch(/runtime-error suite/);
    expect(evaluateOracle({ ...green(), numRuntimeErrorTestSuites: 1 }, greenOpts).join('\n')).toMatch(/runtime-error suite/);
  });
  it('green mode accepts only a successful report whose guarded tests all passed', () => {
    expect(evaluateOracle(green(), greenOpts)).toEqual([]);
  });
  it.each([
    ['an empty report', {}],
    ['a report with no results', { success: true, testResults: [] }],
    ['a collection error and no assertion results', { success: false, testResults: [{ name: FILE, status: 'failed', message: 'Cannot find module', assertionResults: [] }] }],
    ['only unrelated passing files', { success: true, testResults: [{ name: '/w/src/other.test.ts', status: 'passed', assertionResults: Array.from({ length: 40 }, () => row('other', 'passed')) }] }],
    ['success not true', { ...green(), success: false }],
    ['a skipped golden case', { success: true, testResults: [file([row(PREREQ, 'passed'), ...goldens('passed').slice(0, 11), row(goldenName(11), 'skipped')])] }],
    ['a failed prerequisite test', { success: true, testResults: [file([row(PREREQ, 'failed', 'x'), ...goldens('passed')])] }],
  ])('green mode rejects %s', (_label, report) => {
    expect(evaluateOracle(report, greenOpts)).not.toEqual([]);
  });
  it('green mode needs the stated pass count', () => {
    expect(evaluateOracle(green(), { mode: 'green', minPassed: 14 })).not.toEqual([]);
  });
  it('prerequisite mode also rejects an empty report and a load error', () => {
    expect(evaluateOracle({}, prereqOpts)).not.toEqual([]);
    expect(evaluateOracle({ success: false, testResults: [{ name: FILE, status: 'failed', message: 'boom', assertionResults: [] }] }, prereqOpts)).not.toEqual([]);
  });
});
