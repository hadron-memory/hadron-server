import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { stringify } from 'yaml';
import { makeTmpDir } from '../../test/helpers.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';
import {
  buildNodeFrontmatter,
  buildEdgeSidecar,
  type FrontmatterNodeFields,
} from './nodeFrontmatter.js';

const base: FrontmatterNodeFields = { id: 'n1', name: 'A node', tags: [] };

describe('buildNodeFrontmatter', () => {
  it('always emits name and id', () => {
    expect(buildNodeFrontmatter(base)).toEqual({ name: 'A node', id: 'n1' });
  });

  it('emits importer-consumed fields when set (abstract, abstractOriginHash, contentHash)', () => {
    const fm = buildNodeFrontmatter({
      ...base,
      abstract: 'A summary.',
      abstractOriginHash: 'deadbeef',
      contentHash: 'cafebabe',
    });
    expect(fm.abstract).toBe('A summary.');
    expect(fm.abstractOriginHash).toBe('deadbeef');
    expect(fm.contentHash).toBe('cafebabe');
  });

  it('emits the faithful-mirror metadata when set (seq, data, properties)', () => {
    const fm = buildNodeFrontmatter({
      ...base,
      seq: 3,
      data: { version: '0.0.4' },
      properties: { kind: 'ref' },
    });
    expect(fm.seq).toBe(3);
    expect(fm.data).toEqual({ version: '0.0.4' });
    expect(fm.properties).toEqual({ kind: 'ref' });
  });

  it('omits type for the default `info`, emits it otherwise', () => {
    expect(buildNodeFrontmatter({ ...base, nodeType: 'info' })).not.toHaveProperty('type');
    expect(buildNodeFrontmatter({ ...base, nodeType: 'task' }).type).toBe('task');
  });

  it('omits nullish / empty fields', () => {
    const fm = buildNodeFrontmatter({
      ...base,
      alias: null,
      description: '',
      abstract: null,
      abstractOriginHash: null,
      contentHash: null,
      seq: null,
      data: null,
      properties: undefined,
    });
    expect(fm).toEqual({ name: 'A node', id: 'n1' });
  });

  it('emits seq: 0 (a real sort order, not a default to drop)', () => {
    expect(buildNodeFrontmatter({ ...base, seq: 0 }).seq).toBe(0);
  });
});

describe('buildEdgeSidecar', () => {
  it('emits { id, target, rel } in that order when loc is known', () => {
    const [edge] = buildEdgeSidecar([
      { target: { id: 't1', loc: 'srv:msg' }, label: 'p1: feature' },
    ]);
    expect(Object.keys(edge)).toEqual(['id', 'target', 'rel']);
    expect(edge).toEqual({ id: 't1', target: 'srv:msg', rel: 'p1: feature' });
  });

  it('omits target when loc is unknown, and renders a null label as empty rel', () => {
    const [edge] = buildEdgeSidecar([{ target: { id: 't1' }, label: null }]);
    expect(edge).toEqual({ id: 't1', rel: '' });
  });
});

// ---------------------------------------------------------------------------
// Regression: an exported node must round-trip back through the importer
// without losing the importer-consumed fields. Before the shared builder, the
// bulk exporter omitted `abstract` / `abstractOriginHash` / `contentHash`, so a
// re-sync nulled them (loadNodeFromFs → syncGraphFromGithub writes `?? null`).
// ---------------------------------------------------------------------------
describe('exporter → importer round-trip (frontmatter format)', () => {
  let graphRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir: graphRoot, cleanup } = makeTmpDir());
  });
  afterEach(() => cleanup());

  it('preserves abstract, abstractOriginHash and contentHash through a re-import', async () => {
    const body = 'The body of the node.';
    const originHash = computeContentHash(body);
    const frontmatter = buildNodeFrontmatter({
      id: 'aaaa000000000000000000000000000001',
      name: 'srv',
      tags: ['spec', 'p0'],
      abstract: 'Paragraph-length summary that the bulk export used to drop.',
      abstractOriginHash: originHash,
      contentHash: 'abcd1234',
    });

    const mdPath = join(graphRoot, 'srv.md');
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, `---\n${stringify(frontmatter, { lineWidth: 0 }).trim()}\n---\n\n${body}\n`, 'utf-8');

    const { node } = await loadNodeFromFs(mdPath, graphRoot, 'org/repo');
    expect(node.abstract).toBe('Paragraph-length summary that the bulk export used to drop.');
    expect((node as { abstractOriginHash?: string | null }).abstractOriginHash).toBe(originHash);
    expect(node.contentHash).toBe('abcd1234');
    expect(node.content).toBe(body);
  });
});
