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
    expect(graph.nodes[0].loc).toBe('my-org:my-graph');
    expect(graph.nodes[0].name).toBe('my-graph');
  });

  it('sets graph name and ownerRepo correctly', async () => {
    const nodeDir = join(graphRoot, 'my-org', 'my-graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'root' });

    const { graph } = await loadGraphFromFs(graphRoot, 'my-org/my-graph', 'my-org/my-repo');
    expect(graph.name).toBe('my-org/my-graph');
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
    expect(locs).toContain('org:graph');
    expect(locs).toContain('org:graph:sub');
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
    const sourceId = graph.nodes.find((n) => n.loc === 'org:a')!.id;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ sourceId, sourceLoc: 'org:a', targetId, name: 'links to b' });
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

  it('skips hidden directories (other than .hadron)', async () => {
    const hidden = join(graphRoot, '.hidden-dir');
    mkdirSync(join(hidden, '.node'), { recursive: true });
    writeNodeFiles(hidden, { name: 'should-be-hidden' });

    const { graph } = await loadGraphFromFs(graphRoot, 'test/graph', 'test/repo');
    expect(graph.nodes).toHaveLength(0);
  });

  it('discovers nodes inside .hadron/ and strips the prefix from loc', async () => {
    // Nodes stored in .hadron/ (the standard location in project repos)
    const nodeDir = join(graphRoot, '.hadron', 'my-org', 'my-graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'my-graph', description: 'In .hadron' });

    const { graph } = await loadGraphFromFs(graphRoot, 'my-org/my-graph', 'my-org/my-graph');
    expect(graph.nodes).toHaveLength(1);
    // loc must NOT include the .hadron prefix
    expect(graph.nodes[0].loc).toBe('my-org:my-graph');
    expect(graph.nodes[0].name).toBe('my-graph');
  });

  it('discovers nodes both at root and inside .hadron/', async () => {
    // Root-level node
    const rootNode = join(graphRoot, 'org', 'a');
    mkdirSync(rootNode, { recursive: true });
    writeNodeFiles(rootNode, { name: 'a' });

    // .hadron node
    const hadronNode = join(graphRoot, '.hadron', 'org', 'b');
    mkdirSync(hadronNode, { recursive: true });
    writeNodeFiles(hadronNode, { name: 'b' });

    const { graph } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');
    const locs = graph.nodes.map((n) => n.loc).sort();
    expect(locs).toContain('org:a');
    expect(locs).toContain('org:b');
  });
});

/**
 * #1224 — the mirror derives a loc from a file PATH and used to write it
 * unvalidated, while all 11 API write paths call `validateLoc`. These pin the
 * charset half (a clean tightening: zero live production rows violate it) and
 * the root exemption (measured: 7 of 10 live offenders are the graph root,
 * which is the mirror's legitimate address and refusing it would break five
 * live memories).
 */
describe('a path that cannot be a loc (#1224)', () => {
  /** Write a frontmatter node at `<graphRoot>/<relPath>.md`. */
  function writeMd(relPath: string, meta: Record<string, unknown>, body = '# x'): void {
    const full = join(graphRoot, `${relPath}.md`);
    mkdirSync(join(full, '..'), { recursive: true });
    const fm = Object.entries(meta)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    writeFileSync(full, `---\n${fm}\n---\n${body}`, 'utf-8');
  }

  // Each case names the shape it stands for; the first is the issue's own
  // specimen, whose loc would close the skill provenance comment early and
  // turn the remainder into agent-visible instructions.
  const INVALID: Array<[string, string]> = [
    ['evil--> something', 'closes an HTML comment'],
    ['has space', 'a space, which a filename may carry and a URN may not'],
    ['x>y', 'a raw > outside the comment case'],
    ['-leading', 'an atom starting with a hyphen'],
    ['trailing-', 'an atom ending with a hyphen'],
    ['x'.repeat(65), 'an atom past the 64-char FR-017 cap'],
    // A filename MAY contain `:`, so the separator itself is reachable from a
    // path — these are the empty-atom shapes, and they are what keeps the root
    // exemption narrow. Found by mutation: widening it to "any empty atom is
    // fine" passed every other case in this table, because none of them has
    // one.
    ['a::b', 'a doubled separator from a filename — an empty inner atom'],
    [':leading-colon', 'an empty leading atom'],
    ['trailing-colon:', 'an empty trailing atom'],
  ];

  it.each(INVALID)('skips %s (%s) rather than writing the loc', async (fileName) => {
    writeMd('ok', { id: 'keep-me', name: 'ok' });
    writeMd(fileName, { id: 'bad-file-id', name: 'bad' });

    const { graph } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    // The valid sibling still loads — one unusable path must not stop a
    // memory syncing (the per-node catch is the precedent this leans on).
    expect(graph.nodes.map((n) => n.loc)).toEqual(['ok']);
  });

  it('names the FILE and the reason in the warning, so an operator can find it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeMd('evil--> x', { id: 'bad-file-id', name: 'bad' });

    await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toMatch(/evil--> x\.md/);
    expect(line).toMatch(/does not derive a valid loc/);
    warn.mockRestore();
  });

  it('returns the skipped file\'s frontmatter id, so the cleanup pass can spare its row', async () => {
    writeMd('evil--> x', { id: 'bad-file-id', name: 'bad' });

    const { skippedNodeIds } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    // Without this the row is hard-deleted by `notIn: upsertedIds`, so a
    // rename to an invalid name would destroy the node rather than fail to
    // move it. The id is the only handle the caller has on that row.
    expect(skippedNodeIds).toEqual(['bad-file-id']);
  });

  it('reports no skipped ids when every path is usable', async () => {
    // The negative control: `skippedNodeIds` must be able to be EMPTY, or the
    // assertion above proves nothing about the skip having happened.
    writeMd('ok', { id: 'keep-me', name: 'ok' });

    const { graph, skippedNodeIds } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    expect(graph.nodes).toHaveLength(1);
    expect(skippedNodeIds).toEqual([]);
  });

  it('still loads the GRAPH ROOT, whose loc is empty by design', async () => {
    // The exemption, and the case that would have broken five live memories
    // (incl. micromentor.org:mmdata, 533 nodes) had this shipped as a plain
    // `validateLoc` call: a top-level README.md derives `''`, which
    // validateLoc rejects as `empty`.
    writeMd('README', { id: 'root-id', name: 'Hadron Graph' });
    writeMd('server', { id: 'child-id', name: 'server' });

    const { graph, skippedNodeIds } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    expect(graph.nodes.map((n) => n.loc).sort()).toEqual(['', 'server']);
    expect(skippedNodeIds).toEqual([]);
  });

  it('accepts a colon in a filename when the atoms it makes are valid', async () => {
    // The control for the three empty-atom cases above: a `:` in a filename
    // is not itself the defect, it derives a nested loc. Without this, the
    // guard could be "reject any filename containing a colon" and the table
    // above would not notice.
    writeMd('review:sort-imports', { id: 'nested-ok', name: 'ok' });

    const { graph, skippedNodeIds } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    expect(graph.nodes.map((n) => n.loc)).toEqual(['review:sort-imports']);
    expect(skippedNodeIds).toEqual([]);
  });

  it('exempts the root ONLY — a nested README keeps its directory loc', async () => {
    // Pins the exemption's width: it is one whole loc at the root, not "an
    // empty atom is fine". A nested README collapses to its directory, which
    // is an ordinary loc and must still be validated.
    writeMd(join('server', 'README'), { id: 'nested-id', name: 'server' });
    writeMd(join('evil--> dir', 'README'), { id: 'bad-dir-id', name: 'bad' });

    const { graph, skippedNodeIds } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    expect(graph.nodes.map((n) => n.loc)).toEqual(['server']);
    expect(skippedNodeIds).toEqual(['bad-dir-id']);
  });

  it('guards the LEGACY layout too, not just frontmatter files', async () => {
    // Handling only the frontmatter loader would leave the older of the two
    // formats as the unguarded writer — this issue's own shape, and the one
    // #1221 hit with the governed signals.
    const badDir = join(graphRoot, 'evil--> legacy');
    mkdirSync(badDir, { recursive: true });
    writeNodeFiles(badDir, { name: 'bad' });

    const { graph } = await loadGraphFromFs(graphRoot, 'org/graph', 'test/repo');

    expect(graph.nodes).toHaveLength(0);
  });
});
