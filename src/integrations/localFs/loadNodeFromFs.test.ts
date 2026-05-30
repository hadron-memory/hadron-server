import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { stringify } from 'yaml';
import { makeTmpDir, writeNodeFiles, writeFrontmatterNode } from '../../test/helpers.js';
import { loadNodeFromFs } from './loadNodeFromFs.js';

let dir: string;
let cleanup: () => void;
let graphRoot: string;

beforeEach(() => {
  ({ dir, cleanup } = makeTmpDir());
  graphRoot = dir;
});
afterEach(() => cleanup());

describe('loadNodeFromFs', () => {
  it('loads name, description, tags, and content', async () => {
    const nodeDir = join(graphRoot, 'my-org', 'my-graph', 'my-node');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(
      nodeDir,
      { name: 'my-node', description: 'A test node', tags: ['test', 'unit'] },
      '## Content\n\nSome markdown.',
    );

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'my-org/my-graph');
    expect(node.name).toBe('my-node');
    expect(node.description).toBe('A test node');
    expect(node.tags).toEqual(['test', 'unit']);
    expect(node.content).toContain('Some markdown');
  });

  it('derives loc from path relative to graphRoot', async () => {
    const nodeDir = join(graphRoot, 'a', 'b', 'c');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'c' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.loc).toBe('a:b:c');
  });

  it('strips .hadron/ prefix from loc when node lives inside .hadron/', async () => {
    const nodeDir = join(graphRoot, '.hadron', 'my-org', 'my-graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'my-graph' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'my-org/my-graph');
    expect(node.loc).toBe('my-org:my-graph');
  });

  it('returns null content when topic.md is absent', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph' }); // no content arg → no topic.md

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.content).toBeNull();
  });

  it('falls back to summary when description is absent', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph', summary: 'A summary' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.description).toBe('A summary');
  });

  // ─── Spec 031 — abstract import behavior ─────────────────────────────

  it('imports the abstract field from node.yaml frontmatter', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, {
      name: 'graph',
      abstract: 'A paragraph-length summary.',
    });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBe('A paragraph-length summary.');
  });

  it('normalizes whitespace-only abstract to null at import time (FR-009)', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph', abstract: '   \n\t  ' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBeNull();
  });

  it('preserves intentional leading whitespace on a real abstract paragraph', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    const padded = '  This abstract starts with spaces.';
    writeNodeFiles(nodeDir, { name: 'graph', abstract: padded });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBe(padded);
  });

  it('rejects an abstract longer than 2000 characters at import time (FR-008)', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    const overlong = 'x'.repeat(2001);
    writeNodeFiles(nodeDir, { name: 'graph', abstract: overlong });

    await expect(
      loadNodeFromFs(nodeDir, graphRoot, 'test/repo'),
    ).rejects.toThrow(/2000/);
  });

  it('coerces non-string scalar abstract values defensively (e.g. accidental YAML number)', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    // The `yaml` package parses `abstract: 42` as the number 42; the
    // normalizer must coerce-then-trim rather than blow up at runtime.
    writeNodeFiles(nodeDir, { name: 'graph', abstract: 42 });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBe('42');
  });

  it('rejects object-shaped abstract values (would silently corrupt with naive String() coercion)', async () => {
    // YAML frontmatter like:
    //   abstract:
    //     nested: true
    // parses as an object. Naive String() yields "[object Object]" — 15
    // chars that bypass the length cap and the trim-empty check. The
    // normalizer must reject this shape; we treat it as "no abstract"
    // rather than persist garbage. PR-201 round-2 surfaced this gap.
    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      'id: dddd00000000000000000000000000000000\nname: graph\nabstract:\n  nested: true\n',
      'utf-8',
    );

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBeNull();
  });

  it('rejects array-shaped abstract values (same gap as objects)', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      'id: eeee00000000000000000000000000000000\nname: graph\nabstract:\n  - one\n  - two\n',
      'utf-8',
    );

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBeNull();
  });

  it('returns null abstract when the YAML key is absent', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.abstract).toBeNull();
  });

  it('returns empty tags array when tags is absent', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.tags).toEqual([]);
  });

  it('extracts edges from node.yaml nodes array using id', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, {
      name: 'graph',
      nodes: [
        { id: 'aaaa000000000000000000000000000000', rel: 'Related to' },
        { id: 'bbbb000000000000000000000000000000', rel: 'Also related' },
      ],
    });

    const { edges } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({ targetId: 'aaaa000000000000000000000000000000', label: 'Related to' });
    expect(edges[1]).toEqual({ targetId: 'bbbb000000000000000000000000000000', label: 'Also related' });
  });

  it('skips legacy edge entries that have no id', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    // Write a node.yaml with a loc-only edge (no id) directly — bypassing the typed helper
    const { writeFileSync } = await import('fs');
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      'id: cccc00000000000000000000000000000000\nname: graph\nnodes:\n  - loc: org.other\n    rel: legacy\n',
      'utf-8',
    );

    const { edges } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(edges).toHaveLength(0);
  });

  it('returns empty edges when nodes array is absent', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph' });

    const { edges } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(edges).toHaveLength(0);
  });

  it('sets ownerRepo correctly', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'graph' });

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'my-org/my-repo');
    expect(node.ownerRepo).toBe('my-org/my-repo');
  });

  it('throws when node.yaml is missing', async () => {
    const nodeDir = join(graphRoot, 'org', 'missing');
    mkdirSync(join(nodeDir, '.node'), { recursive: true }); // .node dir exists but no node.yaml

    await expect(loadNodeFromFs(nodeDir, graphRoot, 'test/repo')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Frontmatter markdown format (Obsidian vault)
// ---------------------------------------------------------------------------

describe('loadNodeFromFs — frontmatter format', () => {
  it('loads metadata and content from a frontmatter .md file', async () => {
    const mdPath = join(graphRoot, 'architecture.md');
    writeFrontmatterNode(mdPath, { name: 'Architecture', description: 'System overview', tags: ['arch'] }, '# Architecture\n\nContent here.');

    const { node } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(node.name).toBe('Architecture');
    expect(node.description).toBe('System overview');
    expect(node.tags).toEqual(['arch']);
    expect(node.content).toContain('Content here');
    expect(node.loc).toBe('architecture');
  });

  it('derives loc for nested frontmatter files', async () => {
    const mdPath = join(graphRoot, 'server', 'graphql-api.md');
    writeFrontmatterNode(mdPath, { name: 'GraphQL API' });

    const { node } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(node.loc).toBe('server:graphql-api');
  });

  it('derives loc from README.md as folder name', async () => {
    const mdPath = join(graphRoot, 'server', 'README.md');
    writeFrontmatterNode(mdPath, { name: 'Server' });

    const { node } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(node.loc).toBe('server');
  });

  it('loads edges from sidecar edges.yaml', async () => {
    const mdPath = join(graphRoot, 'architecture.md');
    writeFrontmatterNode(
      mdPath,
      { name: 'Architecture' },
      '# Arch',
      [
        { target: 'entities', rel: 'Data model' },
        { target: 'urn', rel: 'Naming scheme', id: 'abc123' },
      ],
    );

    const { edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({ targetId: 'entities', label: 'Data model' });
    expect(edges[1]).toEqual({ targetId: 'abc123', label: 'Naming scheme' });
  });

  it('falls back to frontmatter nodes array when no sidecar exists', async () => {
    const mdPath = join(graphRoot, 'architecture.md');
    writeFrontmatterNode(mdPath, {
      name: 'Architecture',
      nodes: [{ id: 'aaa111', rel: 'Related' }],
    });

    const { edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ targetId: 'aaa111', label: 'Related' });
  });

  it('preserves JSONLogic condition and priority on edges (Invariant 10)', async () => {
    // Write a legacy node with edges that carry condition + priority,
    // then verify the loader surfaces them on the LoadedEdge result.
    // This is the load half of the .node/ round-trip; the save side
    // doesn't currently emit edges (pre-existing gap, tracked
    // separately).
    const nodeDir = join(graphRoot, 'flow', 'check');
    const dotNode = join(nodeDir, '.node');
    mkdirSync(dotNode, { recursive: true });
    writeFileSync(
      join(dotNode, 'node.yaml'),
      stringify({
        id: 'check-node',
        name: 'check',
        nodes: [
          {
            id: 'force-profile',
            rel: 'force-profile',
            priority: 5,
            condition: {
              and: [
                { missing: ['memory.business_type'] },
                { '>': [{ var: 'chat.message_count' }, 20] },
              ],
            },
          },
        ],
      }),
      'utf-8',
    );

    const { edges } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('force-profile');
    expect(edges[0].label).toBe('force-profile');
    expect(edges[0].priority).toBe(5);
    expect(edges[0].condition).toEqual({
      and: [
        { missing: ['memory.business_type'] },
        { '>': [{ var: 'chat.message_count' }, 20] },
      ],
    });
  });

  it('omits condition and priority on edges that have neither', async () => {
    const mdPath = join(graphRoot, 'simple.md');
    writeFrontmatterNode(mdPath, {
      name: 'Simple',
      nodes: [{ id: 'plain-target', rel: 'goes-to' }],
    });
    const { edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ targetId: 'plain-target', label: 'goes-to' });
    expect(edges[0]).not.toHaveProperty('condition');
    expect(edges[0]).not.toHaveProperty('priority');
  });
});
