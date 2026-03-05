import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { makeTmpDir, writeNodeFiles } from '../../test/helpers.js';
import { loadAllGraphsFromFs } from './loadAllGraphsFromFs.js';
let sourcesDir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: sourcesDir, cleanup } = makeTmpDir());
});
afterEach(() => cleanup());

type GraphEntry = { source: string; path: string; version?: string; updatedAt?: string };
function makeConfig(graphs: Record<string, GraphEntry>) {
  return { graphs };
}

describe('loadAllGraphsFromFs', () => {
  it('returns empty array when config has no graphs', async () => {
    const results = await loadAllGraphsFromFs(sourcesDir, makeConfig({}));
    expect(results).toHaveLength(0);
  });

  it('skips graphs whose path does not exist and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await loadAllGraphsFromFs(
      sourcesDir,
      makeConfig({
        'org/missing': {
          source: 'git@github.com:org/missing.git',
          path: 'org/missing',
          version: '1',
          updatedAt: '',
        },
      }),
    );

    expect(results).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    warnSpy.mockRestore();
  });

  it('loads a graph when path exists with nodes', async () => {
    const { mkdirSync } = await import('fs');
    const nodeDir = join(sourcesDir, 'org', 'repo', 'nodeA');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'nodeA', description: 'A node' }, '## Content');

    const results = await loadAllGraphsFromFs(
      sourcesDir,
      makeConfig({
        'org/repo': {
          source: 'git@github.com:org/repo.git',
          path: 'org/repo',
          version: '1',
          updatedAt: '',
        },
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].graph.name).toBe('org/repo');
    expect(results[0].graph.nodes).toHaveLength(1);
  });

  it('loads multiple graphs', async () => {
    const { mkdirSync } = await import('fs');

    const dir1 = join(sourcesDir, 'org', 'repoA', 'node1');
    const dir2 = join(sourcesDir, 'org', 'repoB', 'node2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeNodeFiles(dir1, { name: 'node1' });
    writeNodeFiles(dir2, { name: 'node2' });

    const results = await loadAllGraphsFromFs(
      sourcesDir,
      makeConfig({
        'org/repoA': {
          source: 'git@github.com:org/repoA.git',
          path: 'org/repoA',
          version: '1',
          updatedAt: '',
        },
        'org/repoB': {
          source: 'https://github.com/org/repoB.git',
          path: 'org/repoB',
          version: '1',
          updatedAt: '',
        },
      }),
    );

    expect(results).toHaveLength(2);
  });
});

describe('extractOwnerRepo (via loadAllGraphsFromFs)', () => {
  it('extracts owner/repo from SSH URL', async () => {
    const { mkdirSync } = await import('fs');
    const nodeDir = join(sourcesDir, 'org', 'myrepo', 'n');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'n' });

    const results = await loadAllGraphsFromFs(
      sourcesDir,
      makeConfig({
        'org/myrepo': {
          source: 'git@github.com:org/myrepo.git',
          path: 'org/myrepo',
          version: '1',
          updatedAt: '',
        },
      }),
    );

    expect(results[0].graph.ownerRepo).toBe('org/myrepo');
  });

  it('extracts owner/repo from HTTPS URL', async () => {
    const { mkdirSync } = await import('fs');
    const nodeDir = join(sourcesDir, 'org', 'proj', 'n');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'n' });

    const results = await loadAllGraphsFromFs(
      sourcesDir,
      makeConfig({
        'org/proj': {
          source: 'https://github.com/org/proj.git',
          path: 'org/proj',
          version: '1',
          updatedAt: '',
        },
      }),
    );

    expect(results[0].graph.ownerRepo).toBe('org/proj');
  });
});
