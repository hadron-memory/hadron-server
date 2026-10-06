/** Drain the current file's recorder before Vitest discards its module/client lifetime. */
import { afterAll } from 'vitest';

afterAll(async () => {
  // Import after the file, not before perWorkerDb has selected the private DB.
  const [{ db }, { drainNodeUsage }] = await Promise.all([
    import('../integrations/db/client.js'),
    import('../lib/usageRecorder.js'),
  ]);
  await drainNodeUsage(db);
});
