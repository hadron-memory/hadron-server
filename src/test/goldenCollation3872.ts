/**
 * #3872: the locale prerequisite of the batch-projection golden hashes.
 *
 * The `Referenced by` edge order that src/mcp/server.batchAllocation2774.test.ts hashes depends on the
 * connected database's default collation, so its byte-exact baselines hold only on en_US.UTF-8 (libc).
 * This guard reads the ACTUAL connected database, never a host locale variable or an assumed template,
 * and fails with ONE named error that carries the observed and the required collation and the remedy.
 * It is a test-environment constraint, not a product-wide locale rule: no spec governs it (#3872 FIT)
 * and no product SQL or ordering is touched.
 */

/** The collation the golden baselines were captured under; the name every refusal reports as required. */
export const REQUIRED_GOLDEN_COLLATION = 'en_US.UTF-8';
/**
 * The spellings of that collation admitted, each with evidence (anything else is a mismatch, never an assumed
 * equivalent). `en_US.UTF-8` is what the shared host's databases report. `en_US.utf8` is what the CI
 * PostgreSQL cluster reports for the same glibc locale: the golden hashes pass on it (main's Unit Tests run
 * 42984575047 at 0a6a226f is green) and #3940's first CI run printed that name for the connected database.
 */
const ADMITTED_COLLATIONS: ReadonlySet<string> = new Set([REQUIRED_GOLDEN_COLLATION, 'en_US.utf8']);
/** The only provider admitted with it: libc (`pg_database.datlocprovider = 'c'`). */
const REQUIRED_PROVIDER = 'c';
const PROVIDER_NAMES: Record<string, string> = { c: 'libc', i: 'icu', b: 'builtin' };

export interface ObservedCollation { collate: string | null; provider: string | null }
export type CollationVerdict =
  | { kind: 'match' }
  | { kind: 'mismatch'; collate: string; provider: string }
  | { kind: 'unknown'; reason: string };

export type GoldenCollationErrorCode = 'LOCALE_PREREQUISITE' | 'LOCALE_UNKNOWN' | 'LOCALE_UNREADABLE';
export class GoldenCollationError extends Error {
  constructor(readonly code: GoldenCollationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GoldenCollationError';
  }
}

/** Decide match, mismatch or unknown for what the connected database reports. Pure. */
export function judgeCollation(observed: ObservedCollation | null): CollationVerdict {
  if (!observed) return { kind: 'unknown', reason: 'pg_database returned no row for the connected database' };
  const { collate, provider } = observed;
  if (!collate) return { kind: 'unknown', reason: 'the database reports no collation' };
  if (!provider) return { kind: 'unknown', reason: 'the database reports no collation provider' };
  if (ADMITTED_COLLATIONS.has(collate) && provider === REQUIRED_PROVIDER) return { kind: 'match' };
  return { kind: 'mismatch', collate, provider };
}

/** The setup remedy, shared by every refusal. */
const REMEDY =
  `Run the tests against a private PostgreSQL cluster initialised with \`initdb -E UTF8 --locale=${REQUIRED_GOLDEN_COLLATION}\` ` +
  '(never change the locale of a shared or canonical database); see "Local Postgres setup" in CLAUDE.md.';

/** Human text for a non-match verdict (a match has none). */
export function collationDiagnostic(verdict: CollationVerdict): string {
  if (verdict.kind === 'match') return '';
  if (verdict.kind === 'unknown') {
    return `cannot verify the golden hashes' locale prerequisite: ${verdict.reason}. Required: ${REQUIRED_GOLDEN_COLLATION} (libc). ${REMEDY}`;
  }
  const provider = PROVIDER_NAMES[verdict.provider] ?? `unrecognised provider "${verdict.provider}"`;
  return (
    `golden hashes assume database collation ${REQUIRED_GOLDEN_COLLATION} (libc); the connected test database reports collation ` +
    `${verdict.collate} (provider ${provider}). ${REMEDY}`
  );
}

/** The slice of the Prisma client this guard needs, so a unit pin can hand in a fake. */
export interface CollationQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Read the connected database's collation and provider from pg_database. Returns null when there is not exactly one row. */
export async function readDatabaseCollation(client: CollationQueryClient): Promise<ObservedCollation | null> {
  const rows = await client.$queryRaw<Array<{ collate: string | null; provider: string | null }>>`
    SELECT datcollate AS collate, datlocprovider::text AS provider FROM pg_database WHERE datname = current_database()`;
  return Array.isArray(rows) && rows.length === 1 ? { collate: rows[0]!.collate, provider: rows[0]!.provider } : null;
}

/**
 * Throw one named {@link GoldenCollationError} unless the connected database is en_US.UTF-8 on libc.
 * A mismatch is `LOCALE_PREREQUISITE`; an unreadable or absent value is `LOCALE_UNKNOWN`; a failed query is
 * `LOCALE_UNREADABLE`, never mislabelled as a known mismatch.
 */
export async function assertGoldenCollation(client: CollationQueryClient): Promise<void> {
  let observed: ObservedCollation | null;
  try {
    observed = await readDatabaseCollation(client);
  } catch (e) {
    throw new GoldenCollationError('LOCALE_UNREADABLE', `could not read the database collation: ${e instanceof Error ? e.message : String(e)}`);
  }
  const verdict = judgeCollation(observed);
  if (verdict.kind === 'match') return;
  throw new GoldenCollationError(verdict.kind === 'unknown' ? 'LOCALE_UNKNOWN' : 'LOCALE_PREREQUISITE', collationDiagnostic(verdict));
}
