import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { parse } from 'yaml';
import { makeTmpDir, writeNodeFiles } from '../../test/helpers.js';
import { saveNodeToFs } from './saveNodeToFs.js';
import { loadNodeFromFs } from './loadNodeFromFs.js';

let sourcesPath: string;
let graphRoot: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: sourcesPath, cleanup } = makeTmpDir());
  graphRoot = sourcesPath;
});
afterEach(() => cleanup());

describe('saveNodeToFs', () => {
  it('returns error when loc is missing', async () => {
    const result = await saveNodeToFs({ name: 'no-loc' }, sourcesPath);
    expect(result.error).toBe('Node has no loc');
  });

  it('creates .node directory and writes node.yaml', async () => {
    await saveNodeToFs(
      { loc: 'a.b.c', name: 'c', ownerRepo: 'test/repo' },
      sourcesPath,
    );
    const nodeDir = join(sourcesPath, 'a', 'b', 'c', '.node');
    expect(existsSync(nodeDir)).toBe(true);
    expect(existsSync(join(nodeDir, 'node.yaml'))).toBe(true);
  });

  it('writes name to node.yaml', async () => {
    await saveNodeToFs({ loc: 'a.b', name: 'My Node', ownerRepo: 'r/r' }, sourcesPath);
    const yamlText = readFileSync(join(sourcesPath, 'a', 'b', '.node', 'node.yaml'), 'utf-8');
    const parsed = parse(yamlText) as { name: string };
    expect(parsed.name).toBe('My Node');
  });

  it('writes topic.md when content is provided', async () => {
    await saveNodeToFs(
      { loc: 'a.b', name: 'n', content: '## Hello\n\nWorld.', ownerRepo: 'r/r' },
      sourcesPath,
    );
    const mdPath = join(sourcesPath, 'a', 'b', '.node', 'topic.md');
    expect(existsSync(mdPath)).toBe(true);
    expect(readFileSync(mdPath, 'utf-8')).toContain('Hello');
  });

  it('does NOT write topic.md when content is absent', async () => {
    await saveNodeToFs({ loc: 'a.b', name: 'n', ownerRepo: 'r/r' }, sourcesPath);
    const mdPath = join(sourcesPath, 'a', 'b', '.node', 'topic.md');
    expect(existsSync(mdPath)).toBe(false);
  });

  it('creates nested directories recursively', async () => {
    await saveNodeToFs({ loc: 'x.y.z.deep', name: 'deep', ownerRepo: 'r/r' }, sourcesPath);
    const nodeDir = join(sourcesPath, 'x', 'y', 'z', 'deep', '.node');
    expect(existsSync(nodeDir)).toBe(true);
  });

  it('overwrites existing files on second call', async () => {
    const node = { loc: 'a.b', name: 'original', ownerRepo: 'r/r' };
    await saveNodeToFs(node, sourcesPath);
    await saveNodeToFs({ ...node, name: 'updated' }, sourcesPath);

    const yamlText = readFileSync(join(sourcesPath, 'a', 'b', '.node', 'node.yaml'), 'utf-8');
    const parsed = parse(yamlText) as { name: string };
    expect(parsed.name).toBe('updated');
  });

  it('round-trips: save then loadNodeFromFs returns same values', async () => {
    const node = {
      loc: 'org.graph.sub',
      name: 'Sub Node',
      description: 'Round-trip test',
      tags: ['round', 'trip'],
      content: '## Sub\n\nContent here.',
      ownerRepo: 'org/graph',
    };
    await saveNodeToFs(node, sourcesPath);

    const nodeDir = join(sourcesPath, 'org', 'graph', 'sub');
    const { node: loaded } = await loadNodeFromFs(nodeDir, graphRoot, 'org/graph');
    expect(loaded.loc).toBe('org.graph.sub');
    expect(loaded.name).toBe('Sub Node');
    expect(loaded.description).toBe('Round-trip test');
    expect(loaded.tags).toEqual(['round', 'trip']);
    expect(loaded.content).toContain('Content here');
  });
});
