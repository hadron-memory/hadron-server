import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { makeTmpDir, writeNodeFiles } from '../../test/helpers.js';
import { loadGraphFromFs } from './loadGraphFromFs.js';

let graphRoot: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: graphRoot, cleanup } = makeTmpDir());
});
afterEach(() => cleanup());

describe('loadGraphFromFs', () => {
  it('returns an empty graph when no .node/ dirs exist', async () => {
    const { graph, edges } = await loadGraphFromFs(graphRoot, 'my-org/my-graph', 'my-org/my-graph');
    expect(graph.nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('loads a single node', async () => {
    const nodeDir = join(graphRoot, 'my-org', 'my-graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'my-graph', description: 'Root node' }, '## Root');

    const { graph } = await loadGraphFromFs(graphRoot, 'my-org/my-graph', 'my-org/my-graph');
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].loc).toBe('my-org.my-graph');
    expect(graph.nodes[0].name).toBe('my-graph');
  });

  it('sets graph name and namespace correctly', async () => {
    const nodeDir = join(graphRoot, 'my-org', 'my-graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'root' });

    const { graph } = await loadGraphFromFs(graphRoot, 'my-org/my-graph', 'my-org/my-repo');
    expect(graph.name).toBe('my-org/my-graph');
    expect(graph.namespace).toBe('my-org.my-graph');
    expect(graph.ownerRepo).toBe('my-org/my-repo');
  });

  it('discovers nodes at multiple depths', async () => {
    // depth 1
    mkdirSync(join(graphRoot, 'org'), { recursive: true });
    writeNodeFiles(join(graphRoot, 'org'), { name: 'org' });
    // depth 2
    mkdirSync(join(graphRoot, 'org', 'graph'), { recursive: true });
    writeNodeFiles(join(graphRoot, 'org', 'graph'), { name: 'graph' });
    // depth 3
    mkdirSync(join(graphRoot, 'org', 'graph', 'sub'), { recursive: true });
    writeNodeFiles(join(graphRoot, 'org', 'graph', 'sub'), { name: 'sub' });

    const { graph } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');
    const locs = graph.nodes.map((n) => n.loc).sort();
    expect(locs).toContain('org');
    expect(locs).toContain('org.graph');
    expect(locs).toContain('org.graph.sub');
  });

  it('extracts edges between nodes using node ids', async () => {
    const nodeA = join(graphRoot, 'org', 'a');
    const nodeB = join(graphRoot, 'org', 'b');
    mkdirSync(nodeA, { recursive: true });
    mkdirSync(nodeB, { recursive: true });
    const targetId = 'bbbb000000000000000000000000000000';
    writeNodeFiles(nodeA, { name: 'a', nodes: [{ id: targetId, rel: 'links to b' }] });
    writeNodeFiles(nodeB, { id: targetId, name: 'b' });

    const { graph, edges } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');
    const sourceId = graph.nodes.find((n) => n.loc === 'org.a')!.id;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ sourceId, targetId, label: 'links to b' });
  });

  it('logs a warning and continues when a node.yaml is malformed', async () => {
    const bad = join(graphRoot, 'org', 'bad');
    const good = join(graphRoot, 'org', 'good');
    mkdirSync(join(bad, '.node'), { recursive: true });
    mkdirSync(join(good, '.node'), { recursive: true });
    // Write invalid YAML
    writeFileSync(join(bad, '.node', 'node.yaml'), ': : invalid yaml :', 'utf-8');
    writeNodeFiles(good, { name: 'good' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { graph } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');
    warnSpy.mockRestore();

    // Only the good node loads
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].name).toBe('good');
  });

  it('skips hidden directories', async () => {
    const hidden = join(graphRoot, '.hidden-dir');
    mkdirSync(join(hidden, '.node'), { recursive: true });
    writeNodeFiles(hidden, { name: 'should-be-hidden' });

    const { graph } = await loadGraphFromFs(graphRoot, 'test/graph', 'test/repo');
    expect(graph.nodes).toHaveLength(0);
  });
});
