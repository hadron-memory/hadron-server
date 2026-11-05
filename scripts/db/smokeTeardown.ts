type OwnedResources = { database: string; roles: readonly [string, string] };

/** #2683: report the active run-owned cleanup operation before awaiting it. */
export async function timedCleanupStep<T>(
  step: string,
  owned: OwnedResources,
  operation: () => Promise<T>,
  report: (line: string) => void = console.error,
  clock: () => number = performance.now.bind(performance),
): Promise<T> {
  const started = clock();
  const fields = { event: 'serve-role-smoke.cleanup', step, ...owned };
  report(JSON.stringify({ ...fields, state: 'started' }));
  try {
    const result = await operation();
    report(JSON.stringify({ ...fields, state: 'finished', elapsedMs: clock() - started }));
    return result;
  } catch (error) {
    report(JSON.stringify({ ...fields, state: 'failed', elapsedMs: clock() - started }));
    throw error;
  }
}

type CleanupClient = {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
};

/** #2683: only the fixture resources generated and retained by this invocation. */
export async function cleanupOwnedSmokeFixture(client: CleanupClient, owned: OwnedResources, report: (line: string) => void = console.error): Promise<void> {
  const step = <T,>(name: string, operation: () => Promise<T>) => timedCleanupStep(name, owned, operation, report);
  const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
  await step('connect', () => client.connect());
  try {
    await step('drop-database', () => client.query(`DROP DATABASE IF EXISTS ${identifier(owned.database)} WITH (FORCE)`));
    await step('drop-owner-role', () => client.query(`DROP ROLE IF EXISTS ${identifier(owned.roles[0])}`));
    await step('drop-serve-role', () => client.query(`DROP ROLE IF EXISTS ${identifier(owned.roles[1])}`));
  } finally {
    await step('close', () => client.end());
  }
}
