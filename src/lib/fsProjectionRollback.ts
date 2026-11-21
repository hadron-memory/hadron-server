/**
 * Compatibility wrapper for the existing memory-creation transaction boundaries.
 * Root scaffolding is database-only; it has no filesystem snapshot or cleanup.
 * Keep the caller shape until the wrappers can be removed independently.
 */
export const withFsProjectionRollback = async <T>(fn: () => Promise<T>): Promise<T> => fn();
