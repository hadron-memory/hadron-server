import { db } from '../integrations/db/client.js';
import { syncGraphFromGithub } from '../integrations/github/syncGraphFromGithub.js';

/**
 * Controller startup: sync all configured memories from GitHub.
 * Memories are loaded from the Memory table.
 * Runs non-blocking — logs errors but does not prevent the server from starting.
 */
export const startup = async (): Promise<void> => {
  if (process.env.DISABLE_STARTUP_SYNC === 'true') {
    console.log('Startup sync disabled (DISABLE_STARTUP_SYNC=true).');
    return;
  }

  const memories = await db.memory.findMany({
    where: { deletedAt: null, source: { not: null } },
    include: { organization: true },
  });

  if (memories.length === 0) {
    console.log('No memories configured, skipping sync.');
    return;
  }

  console.log(`Starting sync for ${memories.length} memory(s)...`);

  for (const memory of memories) {
    const result = await syncGraphFromGithub(memory);
    if (result.error) {
      console.error(`  [FAIL] ${memory.organization.urn}/${memory.name}: ${result.error}`);
    } else {
      console.log(`  [OK]   ${memory.organization.urn}/${memory.name}: ${result.nodeCount} nodes`);
    }
  }

  console.log('Memory sync complete.');
};
