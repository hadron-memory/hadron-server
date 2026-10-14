/**
 * #1951 — the graph-fixture root is scoped to the run, not shared.
 *
 * `createNode` writes every node it creates to disk under `GRAPHS_PATH`. Tests
 * used to pin that to ONE shared `/tmp/hadron-test-graphs`, and nothing ever
 * removed what landed there: ~100K directories in nine days filled /tmp's
 * inodes on the shared host, and suites failed with ENOSPC mid-transform.
 */
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { GRAPHS_PATH } from '../config.js';
import { testRunId } from './dbWorkers.js';

describe('#1951 graph-fixture root', () => {
  it('points this run at its own root, named for the run id (the vitest main pid)', () => {
    expect(GRAPHS_PATH).toBe(join(tmpdir(), 'hadron-test-graph-runs', `r${testRunId()}`));
  });

  it('is not the old shared root', () => {
    expect(GRAPHS_PATH).not.toBe('/tmp/hadron-test-graphs');
    expect(GRAPHS_PATH.startsWith('/tmp/hadron-test-graphs/')).toBe(false);
  });

  it('globalSetup creates the root before any worker writes to it', () => {
    expect(existsSync(GRAPHS_PATH)).toBe(true);
  });
});
