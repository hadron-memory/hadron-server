import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';
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
});
