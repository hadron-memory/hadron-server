import { db } from '../integrations/db/client.js';
import { syncGraphFromGithub } from '../integrations/github/syncGraphFromGithub.js';

/**
 * True while a sync is running IN THIS PROCESS.
 *
 * #556 — the guard lives on the OPERATION, not on the route that triggers it
 * (@codex, PR #1250). It was first written into the `/reload` handler, which
 * covered reloads and nothing else: `src/index.ts` calls `startup()` directly
 * at boot, so a CI trigger arriving during the initial sync — the single most
 * likely moment for one, right after a deploy — saw a false flag and started a
 * second sync over the same checkouts. A guard that only knows about one of an
 * operation's two callers is not a guard on the operation.
 *
 * PER PROCESS, and that qualification is load-bearing (@copilot, same PR): two
 * workers or replicas each hold their own flag and would both proceed. The
 * container runs ONE node process today (`Dockerfile` CMD is a single
 * `pnpm tsx src/index.ts`), which is why this is sufficient rather than
 * correct — anything that runs this behind pm2 or multiple replicas needs a
 * real distributed lock, and the concurrent git checkouts it prevents are a
 * data hazard rather than a load one.
 */
let syncInFlight = false;

/** True when a graph sync is currently running in this process. */
export const isSyncInFlight = (): boolean => syncInFlight;

/**
 * Controller startup: sync all configured memories from GitHub.
 * Memories are loaded from the Memory table.
 * Runs non-blocking — logs errors but does not prevent the server from starting.
 *
 * Returns `'skipped'` when a sync was already running, so a caller can tell
 * "already in progress" from "done". Boot ignores the distinction; `/reload`
 * turns it into a 409.
 */
export const startup = async (): Promise<'ran' | 'skipped'> => {
  if (syncInFlight) {
    console.log('Sync already in progress — skipping this request.');
    return 'skipped';
  }
  syncInFlight = true;
  try {
    return await runStartup();
  } finally {
    // `finally`, not the happy path: a sync that throws must still release the
    // flag, or one failure wedges every future sync until the process
    // restarts.
    syncInFlight = false;
  }
};

const runStartup = async (): Promise<'ran'> => {
  if (process.env.DISABLE_STARTUP_SYNC === 'true') {
    console.log('Startup sync disabled (DISABLE_STARTUP_SYNC=true).');
    return 'ran';
  }

  const memories = await db.memory.findMany({
    where: { deletedAt: null, source: { not: null } },
    include: { organization: true },
  });

  if (memories.length === 0) {
    console.log('No memories configured, skipping sync.');
    return 'ran';
  }

  console.log(`Starting sync for ${memories.length} memory(s)...`);

  for (const memory of memories) {
    // spec 047: user-owned memories have no org and aren't git-synced.
    if (!memory.organization) continue;
    const orgUrn = memory.organization.urn;
    const result = await syncGraphFromGithub(memory);
    if (result.error) {
      console.error(`  [FAIL] ${orgUrn}/${memory.name}: ${result.error}`);
    } else {
      console.log(`  [OK]   ${orgUrn}/${memory.name}: ${result.nodeCount} nodes`);
    }
  }

  console.log('Memory sync complete.');
  return 'ran';
};
