/** #448 — opt-in Prisma pool tuning; existing URL parameters always win. */
type PoolEnvironment = {
  DB_POOL_CONNECTION_LIMIT?: string;
  DB_POOL_TIMEOUT_SECONDS?: string;
};

function positiveInteger(name: keyof PoolEnvironment, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    // Deliberately name the setting, never its value (or the credential-bearing URL).
    throw new Error(`${name} must be a positive safe integer`);
  }
  return String(Number(value));
}

export function poolDatasourceUrl(databaseUrl: string | undefined, env: PoolEnvironment): string | undefined {
  const limit = positiveInteger('DB_POOL_CONNECTION_LIMIT', env.DB_POOL_CONNECTION_LIMIT);
  const timeout = positiveInteger('DB_POOL_TIMEOUT_SECONDS', env.DB_POOL_TIMEOUT_SECONDS);
  // Preserve Prisma's existing URL/env handling and every byte when not opted in.
  if (limit === undefined && timeout === undefined) return databaseUrl;
  let url: URL;
  try {
    url = new URL(databaseUrl!);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL when pool settings are configured');
  }
  let changed = false;
  for (const [name, value] of [['connection_limit', limit], ['pool_timeout', timeout]] as const) {
    if (value !== undefined && !url.searchParams.has(name)) {
      url.searchParams.set(name, value);
      changed = true;
    }
  }
  return changed ? url.toString() : databaseUrl;
}
