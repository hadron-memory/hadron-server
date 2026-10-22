/**
 * vitest setupFile — points this worker's `GRAPHS_PATH` at the run's own
 * graph-fixture root (#1951/#1137; inherited scope plus bare main PID) before any test file imports `config.ts`.
 *
 * Set here rather than in `vitest.config.ts`'s `env`, which is evaluated once
 * with no run id, and unconditionally so a `GRAPHS_PATH` from a developer's
 * `.env` cannot route a run's writes somewhere nothing cleans.
 */
import { testRunId } from './dbWorkers.js';
import { runGraphRoot } from './graphRoot.js';

process.env.GRAPHS_PATH = runGraphRoot(testRunId());
