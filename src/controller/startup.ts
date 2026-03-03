import { existsSync } from 'fs';
import { loadConfig, SOURCES_PATH } from '../config.js';
import { syncGraphFromGithub } from '../integrations/github/syncGraphFromGithub.js';

/**
 * Controller startup: sync all configured graphs from GitHub.
 * Runs non-blocking — logs errors but does not prevent the server from starting.
 */
export const startup = async (): Promise<void> => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.warn('No .hadron-controller.yaml found, skipping graph sync:', (err as Error).message);
    return;
  }

  const graphNames = Object.keys(config.graphs);
  if (graphNames.length === 0) {
    console.log('No graphs configured, skipping sync.');
    return;
  }

  console.log(`Starting sync for ${graphNames.length} graph(s)...`);

  for (const name of graphNames) {
    const result = await syncGraphFromGithub(name);
    if (result.error) {
      console.error(`  [FAIL] ${name}: ${result.error}`);
    } else {
      console.log(`  [OK]   ${name}: ${result.nodeCount} nodes`);
    }
  }

  console.log('Graph sync complete.');
};
