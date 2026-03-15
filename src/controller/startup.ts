import { db } from '../integrations/db/client.js';
import { syncGraphFromGithub } from '../integrations/github/syncGraphFromGithub.js';

/**
 * Controller startup: sync all configured graphs from GitHub.
 * Graphs are loaded from the Graph table.
 * Runs non-blocking — logs errors but does not prevent the server from starting.
 */
export const startup = async (): Promise<void> => {
  const graphs = await db.graph.findMany({
    where: { deletedAt: null, source: { not: null } },
    include: { organization: true },
  });

  if (graphs.length === 0) {
    console.log('No graphs configured, skipping sync.');
    return;
  }

  console.log(`Starting sync for ${graphs.length} graph(s)...`);

  for (const graph of graphs) {
    const result = await syncGraphFromGithub(graph);
    if (result.error) {
      console.error(`  [FAIL] ${graph.organization.domain}/${graph.name}: ${result.error}`);
    } else {
      console.log(`  [OK]   ${graph.organization.domain}/${graph.name}: ${result.nodeCount} nodes`);
    }
  }

  console.log('Graph sync complete.');
};
