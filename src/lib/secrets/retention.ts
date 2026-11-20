/**
 * #4003 (S8 of #3991) — how long a superseded App secret version is kept (open question 10, ruled R5, Holger
 * 2026-11-12: "A superseded version is hard-deleted 30 days after it was superseded (the current one never; the
 * 50-version cap purges the oldest early)").
 *
 * `SECRET_VERSION_RETENTION_DAYS`: a plain decimal integer from 1 to 3650, read per call. Unset is the default (30)
 * silently. An empty or invalid value (0, negatives, fractions, exponent, hex or signed spellings, above 3650, junk)
 * is ALSO the default, with one warn line per process, so a typo can neither keep old values forever nor purge them
 * at once. The warning names the variable and never echoes the value.
 */

export const SECRET_VERSION_RETENTION_ENV = 'SECRET_VERSION_RETENTION_DAYS';
export const DEFAULT_SECRET_VERSION_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

let warned = false;

/** The retention window in days; see the module comment for the fallback rule. */
export function secretVersionRetentionDays(): number {
  const raw = process.env[SECRET_VERSION_RETENTION_ENV];
  if (raw === undefined) return DEFAULT_SECRET_VERSION_RETENTION_DAYS;
  const trimmed = raw.trim();
  if (/^[0-9]{1,4}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 1 && n <= MAX_RETENTION_DAYS) return n;
  }
  if (!warned) {
    warned = true;
    console.warn(
      `secret_version_retention_env_invalid: ${SECRET_VERSION_RETENTION_ENV} must be an integer from 1 to ${MAX_RETENTION_DAYS}; using ${DEFAULT_SECRET_VERSION_RETENTION_DAYS}`,
    );
  }
  return DEFAULT_SECRET_VERSION_RETENTION_DAYS;
}

/** Test seam: forget that the warning was given. */
export function resetSecretRetentionWarningsForTests(): void {
  warned = false;
}
