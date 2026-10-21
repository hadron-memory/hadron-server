/**
 * #1951 — the graph-fixture root is scoped to the run, not shared.
 *
 * `createNode` writes every node it creates to disk under `GRAPHS_PATH`. Tests
 * used to pin that to ONE shared `/tmp/hadron-test-graphs`, and nothing ever
 * removed what landed there: ~100K directories in nine days filled /tmp's
 * inodes on the shared host, and suites failed with ENOSPC mid-transform.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GRAPHS_PATH } from '../config.js';
import { testRunId, runToken } from './dbWorkers.js';
import {
  parseRunGraphRootName,
  prepareRunGraphRoot,
  removeRunGraphRoot,
  runGraphRoot,
  sweepOrphanGraphRoots,
} from './graphRoot.js';

/** A pid that existed and has exited: a child we spawned and waited for. */
function deadPid(): string {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  if (!pid) throw new Error('spawnSync returned no pid');
  return String(pid);
}

describe('#1951 graph-fixture root', () => {
  it('points this run at its own root, named for the run id (the vitest main pid)', () => {
    expect(GRAPHS_PATH).toBe(join(tmpdir(), 'hadron-test-graph-runs', `r${runToken(testRunId())}`));
  });

  it('is not the old shared root', () => {
    expect(GRAPHS_PATH).not.toBe('/tmp/hadron-test-graphs');
    expect(GRAPHS_PATH.startsWith('/tmp/hadron-test-graphs/')).toBe(false);
  });

  it('globalSetup creates the root before any worker writes to it', () => {
    expect(existsSync(GRAPHS_PATH)).toBe(true);
  });
});

describe('#1951 graph-root lifecycle', () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'graph-root-1951-'));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  /** A run root holding a node directory, the shape createNode leaves. */
  function seedRoot(runId: string): string {
    const root = runGraphRoot(runId, parent);
    mkdirSync(join(root, 'sp-mem-1792007591196-98039', '.node'), { recursive: true });
    writeFileSync(join(root, 'sp-mem-1792007591196-98039', '.node', 'node.yaml'), 'id: x\n');
    return root;
  }

  it('reads the run id only from an r<digits> name', () => {
    expect(parseRunGraphRootName(`r${runToken('12345')}`)).toBe(runToken('12345'));
    expect(parseRunGraphRootName('r12345')).toBeNull();
    for (const name of ['12345', 'r', 'r12a', 'rx', 'sp-mem-1792007591196-98039', 'r123/']) {
      expect(parseRunGraphRootName(name)).toBeNull();
    }
  });

  it('sweeps a root whose pid is dead', () => {
    const dead = deadPid();
    seedRoot(dead);
    expect(sweepOrphanGraphRoots('1', parent)).toEqual([`r${runToken(dead)}`]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('never sweeps a live run, however old its root', () => {
    // This worker and its parent are both alive; age is not consulted at all.
    const live = [String(process.pid), String(process.ppid)];
    for (const pid of live) seedRoot(pid);
    expect(sweepOrphanGraphRoots('1', parent)).toEqual([]);
    expect(readdirSync(parent).sort()).toEqual(live.map((p) => `r${runToken(p)}`).sort());
  });

  it('leaves the calling run its own root, and anything that is not a run root', () => {
    const own = deadPid(); // even a dead pid: the caller owns it and decides
    seedRoot(own);
    mkdirSync(join(parent, 'not-a-run'));
    expect(sweepOrphanGraphRoots(own, parent)).toEqual([]);
    expect(readdirSync(parent).sort()).toEqual([`r${runToken(own)}`, 'not-a-run'].sort());
  });

  it('prepare starts the run on an EMPTY root even when a crashed run with our pid left one', () => {
    const own = String(process.pid);
    const dead = deadPid();
    seedRoot(own);
    seedRoot(dead);
    const root = prepareRunGraphRoot(own, parent);
    expect(root).toBe(runGraphRoot(own, parent));
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(parent)).toEqual([`r${runToken(own)}`]);
  });

  it('teardown removes the root and returns the parent to its pre-run state', () => {
    mkdirSync(join(parent, 'not-a-run'));
    const before = readdirSync(parent).sort();
    const own = String(process.pid);
    prepareRunGraphRoot(own, parent);
    seedRoot(own);
    removeRunGraphRoot(own, parent);
    expect(readdirSync(parent).sort()).toEqual(before);
  });
});
