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
  it.each([
    ['C.UTF-8 libc', { collate: 'C.UTF-8', provider: 'c' }],
    ['unadmitted spelling en_US.utf8', { collate: 'en_US.utf8', provider: 'c' }],
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
    const bytewise = ['B', '_a', 'a'];
    expect(sorted).toEqual(/^(C|POSIX)(\.|$)/.test(observed?.collate ?? '') ? bytewise : ['_a', 'a', 'B']);
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
  const t = (status: string, message = '') => ({ fullName: 'x', status, failureMessages: message ? [message] : [] });
  const report = (...rows: ReturnType<typeof t>[]) => ({ testResults: [{ assertionResults: rows }] });
  const named = 'LOCALE_PREREQUISITE: golden hashes need en_US.UTF-8, database is C.UTF-8; initdb --locale=en_US.UTF-8';
  const opts = { mode: 'prerequisite-failure', actual: 'C.UTF-8', required: 'en_US.UTF-8' };
  it('accepts one named failure and no opaque mismatch', () => {
    expect(evaluateOracle(report(t('failed', named), t('passed'), t('skipped')), opts)).toEqual([]);
  });
  it('rejects the pre-fix state: twelve opaque hash mismatches and no named failure', () => {
    const opaque = t('failed', "AssertionError: response hash mismatch: node n, field Referenced by: expected '4beced6f140838116be795a5d4b0c23b0affb8e4830f89249e8dba03dc216f5f'");
    const v = evaluateOracle(report(...Array.from({ length: 12 }, () => opaque), t('passed')), opts);
    expect(v.join('\n')).toMatch(/12 opaque/);
    expect(v.join('\n')).toMatch(/exactly 1 named/);
  });
  it('rejects a repeated named failure and a named failure beside an opaque one', () => {
    expect(evaluateOracle(report(t('failed', named), t('failed', named)), opts).join('\n')).toMatch(/found 2/);
    expect(evaluateOracle(report(t('failed', named), t('failed', 'response hash mismatch: x')), opts).join('\n')).toMatch(/opaque/);
  });
  it('green mode needs zero failures and the stated pass count', () => {
    expect(evaluateOracle(report(t('passed'), t('passed')), { mode: 'green', minPassed: 2 })).toEqual([]);
    expect(evaluateOracle(report(t('passed'), t('failed', 'x')), { mode: 'green', minPassed: 1 })).not.toEqual([]);
    expect(evaluateOracle(report(t('passed')), { mode: 'green', minPassed: 2 })).not.toEqual([]);
  });
});
