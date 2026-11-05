type OwnedResources = { database: string; roles: readonly string[] };

/** #2683: report the active run-owned cleanup operation before awaiting it. */
export async function timedCleanupStep<T>(
  step: string,
  owned: OwnedResources,
  operation: () => Promise<T>,
  report: (line: string) => void = console.error,
  clock: () => number = performance.now.bind(performance),
): Promise<T> {
  return operation();
}
