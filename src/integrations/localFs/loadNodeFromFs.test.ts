import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    expect(edges[0]).toEqual({ targetId: 'aaaa000000000000000000000000000000', name: 'Related to' });
    expect(edges[1]).toEqual({ targetId: 'bbbb000000000000000000000000000000', name: 'Also related' });
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
    expect(edges[0]).toEqual({ targetId: 'entities', name: 'Data model' });
    expect(edges[1]).toEqual({ targetId: 'abc123', name: 'Naming scheme' });
  });

  it('falls back to frontmatter nodes array when no sidecar exists', async () => {
    const mdPath = join(graphRoot, 'architecture.md');
    writeFrontmatterNode(mdPath, {
      name: 'Architecture',
      nodes: [{ id: 'aaa111', rel: 'Related' }],
    });

    const { edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ targetId: 'aaa111', name: 'Related' });
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
    expect(edges[0].name).toBe('force-profile');
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
    expect(edges[0]).toEqual({ targetId: 'plain-target', name: 'goes-to' });
    expect(edges[0]).not.toHaveProperty('condition');
    expect(edges[0]).not.toHaveProperty('priority');
  });
});

// ─── Spec 032 — abstractOriginHash validate-on-import (FR-013) ──────────

describe('loadNodeFromFs — abstractOriginHash validate-and-warn (spec 032)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('without an abstractOriginHash key: importer recomputes from content', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(
      nodeDir,
      { name: 'graph', abstract: 'Summary of the body.' },
      'Body content.',
    );

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    const { computeContentHash } = await import('../../lib/contentHash.js');
    expect((node as { abstractOriginHash: string | null }).abstractOriginHash).toBe(
      computeContentHash('Body content.'),
    );
  });

  it('with a matching abstractOriginHash key: clean round-trip, no warning', async () => {
    const { computeContentHash } = await import('../../lib/contentHash.js');
    const body = 'Body content.';
    const matchingHash = computeContentHash(body);

    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      `id: aaaa00000000000000000000000000000001\nname: graph\nabstract: Summary.\nabstractOriginHash: ${matchingHash}\n`,
      'utf-8',
    );
    writeFileSync(join(nodeMetaDir, 'topic.md'), body, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect((node as { abstractOriginHash: string | null }).abstractOriginHash).toBe(matchingHash);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('with a mismatching abstractOriginHash key: accept YAML value + emit warning', async () => {
    const tamperedHash = 'deadbeef';
    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      `id: bbbb00000000000000000000000000000002\nname: graph\nabstract: Summary.\nabstractOriginHash: ${tamperedHash}\n`,
      'utf-8',
    );
    writeFileSync(join(nodeMetaDir, 'topic.md'), 'Body that does not match tampered hash.', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect((node as { abstractOriginHash: string | null }).abstractOriginHash).toBe(tamperedHash);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/abstractOriginHash mismatch/);
  });

  it('with abstract: null: abstractOriginHash forced to null regardless of YAML', async () => {
    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      `id: cccc00000000000000000000000000000003\nname: graph\nabstractOriginHash: deadbeef\n`,
      'utf-8',
    );
    writeFileSync(join(nodeMetaDir, 'topic.md'), 'Body.', 'utf-8');

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect((node as { abstractOriginHash: string | null }).abstractOriginHash).toBeNull();
  });

  it('non-string abstractOriginHash (number / object / array): falls through to recompute', async () => {
    const { computeContentHash } = await import('../../lib/contentHash.js');
    const body = 'Body.';
    const nodeDir = join(graphRoot, 'org', 'graph');
    const nodeMetaDir = join(nodeDir, '.node');
    mkdirSync(nodeMetaDir, { recursive: true });
    writeFileSync(
      join(nodeMetaDir, 'node.yaml'),
      `id: dddd00000000000000000000000000000004\nname: graph\nabstract: Summary.\nabstractOriginHash:\n  nested: true\n`,
      'utf-8',
    );
    writeFileSync(join(nodeMetaDir, 'topic.md'), body, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect((node as { abstractOriginHash: string | null }).abstractOriginHash).toBe(
      computeContentHash(body),
    );
    // No warning — non-string is treated as "missing", not "tampered".
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// #280 — the importer read frontmatter with an LF-only regex, so a CRLF file
// (a Windows author, or `core.autocrlf=true` on the clone host) threw "No
// frontmatter found" and was silently dropped from the loaded graph. And
// `parse()` returns null or a primitive for empty or bare-value YAML, which
// both loaders then died on with a bare TypeError; those now fail naming the
// file. Other non-mapping roots (arrays, tagged Set/Map/Buffer) still load as
// before, because a refused file loses its row to git sync's cleanup pass (PR
// #1432 review). These fixtures are written byte-for-byte rather than through
// `writeFrontmatterNode`, which only emits LF.
describe('loadNodeFromFs — line endings and YAML root shape (#280)', () => {
  const lfFile = [
    '---',
    'id: node-280',
    'name: Line endings',
    'description: One-line headline',
    'tags:',
    '  - a',
    '  - b',
    'role: skill',
    'nodes:',
    '  - id: target-1',
    '    rel: Related',
    '---',
    '',
    '# Heading',
    '',
    'Body with a {{placeholder}} and --- inside a line.',
    '',
  ].join('\n');

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('loads a %s frontmatter file with identical metadata and edges', async (_label, eol) => {
    const mdPath = join(graphRoot, 'server', 'line-endings.md');
    mkdirSync(join(graphRoot, 'server'), { recursive: true });
    writeFileSync(mdPath, lfFile.replace(/\n/g, eol), 'utf-8');

    const { node, edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(node.id).toBe('node-280');
    expect(node.loc).toBe('server:line-endings');
    expect(node.name).toBe('Line endings');
    expect(node.description).toBe('One-line headline');
    expect(node.tags).toEqual(['a', 'b']);
    expect(node).toMatchObject({ role: 'skill' });
    expect(node.ownerRepo).toBe('test/repo');
    expect(edges).toEqual([{ targetId: 'target-1', name: 'Related' }]);
    // Same stored body either way: CRLF is normalized to LF, as the CLI's
    // import does, so a checkout that flips line endings does not rewrite the
    // node. The placeholder and the mid-line `---` are untouched.
    expect(node.content).toBe('# Heading\n\nBody with a {{placeholder}} and --- inside a line.');
  });

  it('loads a CRLF file whose closing delimiter is the last line (no body)', async () => {
    const mdPath = join(graphRoot, 'bare.md');
    writeFileSync(mdPath, '---\r\nid: bare\r\nname: Bare\r\n---', 'utf-8');

    const { node } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(node.id).toBe('bare');
    expect(node.content).toBeNull();
  });

  it('gives a CRLF file sidecar edges precedence, same as LF', async () => {
    const mdPath = join(graphRoot, 'architecture.md');
    writeFileSync(
      mdPath,
      '---\r\nid: arch\r\nname: Architecture\r\nnodes:\r\n  - id: from-frontmatter\r\n    rel: Ignored\r\n---\r\n\r\nBody\r\n',
      'utf-8',
    );
    mkdirSync(join(graphRoot, '.architecture'), { recursive: true });
    writeFileSync(
      join(graphRoot, '.architecture', 'edges.yaml'),
      '- target: from-sidecar\r\n  rel: Wins\r\n',
      'utf-8',
    );

    const { edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
    expect(edges).toEqual([{ targetId: 'from-sidecar', name: 'Wins' }]);
  });

  it('still refuses a file with no frontmatter at all', async () => {
    const mdPath = join(graphRoot, 'plain.md');
    writeFileSync(mdPath, '# Just markdown\r\n', 'utf-8');

    await expect(loadNodeFromFs(mdPath, graphRoot, 'test/repo')).rejects.toThrow(
      `No frontmatter found in ${mdPath}`,
    );
  });

  // Each of these already failed to load before #280, with a bare TypeError
  // (`meta.id` on null, or `'role' in` a primitive). Only the message changes.
  it.each([
    ['empty', '', 'empty'],
    ['a comment only', '# nothing here', 'empty'],
    ['a scalar', 'just a string', 'a string'],
    ['a number', '42', 'a number'],
  ])('refuses frontmatter that is %s, naming the file', async (_label, yamlBody, got) => {
    const mdPath = join(graphRoot, 'bad.md');
    // A blank line between the delimiters: the regex needs a newline before
    // the closing `---`, so `---\n---` is "no frontmatter" rather than empty.
    writeFileSync(mdPath, `---\n${yamlBody}\n---\n\nBody\n`, 'utf-8');

    await expect(loadNodeFromFs(mdPath, graphRoot, 'test/repo')).rejects.toThrow(
      `Malformed frontmatter in ${mdPath}: expected a YAML mapping, got ${got}`,
    );
  });

  it('refuses frontmatter that is not valid YAML, naming the file', async () => {
    const mdPath = join(graphRoot, 'broken.md');
    writeFileSync(mdPath, '---\r\nid: [unclosed\r\n---\r\n', 'utf-8');

    await expect(loadNodeFromFs(mdPath, graphRoot, 'test/repo')).rejects.toThrow(
      `Malformed frontmatter in ${mdPath}:`,
    );
  });

  // The legacy layout never used the LF-only split, so CRLF already loaded.
  // Its topic.md body is deliberately left as it was (CRLF kept): normalizing
  // it here would rewrite the stored content of legacy nodes that load fine
  // today, which is a change #280 does not ask for.
  it('loads a legacy node.yaml written with CRLF, body unchanged', async () => {
    const nodeDir = join(graphRoot, 'org', 'legacy');
    mkdirSync(join(nodeDir, '.node'), { recursive: true });
    writeFileSync(join(nodeDir, '.node', 'node.yaml'), 'id: legacy-1\r\nname: Legacy\r\n', 'utf-8');
    writeFileSync(join(nodeDir, '.node', 'topic.md'), 'Body\r\nline two\r\n', 'utf-8');

    const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
    expect(node.id).toBe('legacy-1');
    expect(node.name).toBe('Legacy');
    expect(node.loc).toBe('org:legacy');
    expect(node.content).toBe('Body\r\nline two');
  });

  it.each([
    ['empty', '', 'empty'],
    ['a scalar', 'just a string', 'a string'],
  ])('refuses a legacy node.yaml that is %s, naming the file', async (_label, yamlBody, got) => {
    const nodeDir = join(graphRoot, 'org', 'legacy');
    const yamlPath = join(nodeDir, '.node', 'node.yaml');
    mkdirSync(join(nodeDir, '.node'), { recursive: true });
    writeFileSync(yamlPath, yamlBody, 'utf-8');

    await expect(loadNodeFromFs(nodeDir, graphRoot, 'test/repo')).rejects.toThrow(
      `Malformed node.yaml in ${yamlPath}: expected a YAML mapping, got ${got}`,
    );
  });

  it('refuses a legacy node.yaml that is not valid YAML, naming the file', async () => {
    const nodeDir = join(graphRoot, 'org', 'legacy');
    const yamlPath = join(nodeDir, '.node', 'node.yaml');
    mkdirSync(join(nodeDir, '.node'), { recursive: true });
    writeFileSync(yamlPath, 'id: [unclosed\n', 'utf-8');

    await expect(loadNodeFromFs(nodeDir, graphRoot, 'test/repo')).rejects.toThrow(
      `Malformed node.yaml in ${yamlPath}:`,
    );
  });

  // PR #1432 review P1/P2. These roots loaded before #280 as a node with no id
  // and no name, and they must keep loading. Git sync then updates the existing
  // row in place instead of dropping the file and hard-deleting the row in
  // its cleanup pass. Tightening this to a mapping-only check is a deliberate
  // later step, once sync keeps the row of a refused file. It must not happen
  // as a side effect.
  const nonMappingObjectRoots: Array<[string, string]> = [
    ['an array', '- id: x\n- name: y'],
    ['a !!set', '!!set {a: null}'],
    ['a !!omap', '!!omap [a: 1]'],
    ['a !!binary', '!!binary SGVsbG8='],
  ];

  it.each(nonMappingObjectRoots)(
    'still loads frontmatter that is %s, as before #280 (no id, no name)',
    async (_label, yamlBody) => {
      const mdPath = join(graphRoot, 'odd.md');
      writeFileSync(mdPath, `---\r\n${yamlBody.replace(/\n/g, '\r\n')}\r\n---\r\n\r\nBody\r\n`, 'utf-8');

      const { node, edges } = await loadNodeFromFs(mdPath, graphRoot, 'test/repo');
      expect(node.id).toBeUndefined();
      expect(node.name).toBeUndefined();
      expect(node.loc).toBe('odd');
      expect(node.content).toBe('Body');
      expect(edges).toEqual([]);
    },
  );

  it.each(nonMappingObjectRoots)(
    'still loads a legacy node.yaml that is %s, as before #280 (no id, no name)',
    async (_label, yamlBody) => {
      const nodeDir = join(graphRoot, 'org', 'legacy');
      mkdirSync(join(nodeDir, '.node'), { recursive: true });
      writeFileSync(join(nodeDir, '.node', 'node.yaml'), yamlBody, 'utf-8');

      const { node } = await loadNodeFromFs(nodeDir, graphRoot, 'test/repo');
      expect(node.id).toBeUndefined();
      expect(node.name).toBeUndefined();
      expect(node.loc).toBe('org:legacy');
    },
  );
});
