type OwnedResources = { database: string; roles: readonly string[] };

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
  await client.connect();
  await client.end();
}
