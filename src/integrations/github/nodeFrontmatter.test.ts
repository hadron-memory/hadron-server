import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { stringify } from 'yaml';
import { makeTmpDir } from '../../test/helpers.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';
import {
  buildNodeFrontmatter,
  buildEdgeFrontmatter,
  nodeFilePath,
  orphanedLegacyPaths,
  type FrontmatterNodeFields,
  type EdgeForGit,
} from './nodeFrontmatter.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';

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

  it('#725 — round-trips objectType (emitted when set, omitted when absent)', () => {
    expect(buildNodeFrontmatter({ ...base, objectType: 'competitor' }).objectType).toBe('competitor');
    expect(buildNodeFrontmatter({ ...base })).not.toHaveProperty('objectType');
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

  it('embeds outgoing edges inline as nodes: when present, omits when empty', () => {
    expect(buildNodeFrontmatter(base)).not.toHaveProperty('nodes');
    expect(buildNodeFrontmatter(base, [])).not.toHaveProperty('nodes');
    const fm = buildNodeFrontmatter(base, [
      { target: { id: 't1', loc: 'srv:msg' }, name: 'p1: feature' },
    ]);
    expect(fm.nodes).toEqual([{ id: 't1', loc: 'srv:msg', rel: 'p1: feature' }]);
  });
});

describe('buildEdgeFrontmatter', () => {
  it('emits { id, loc, rel } in that order when loc is known', () => {
    const [edge] = buildEdgeFrontmatter([
      { target: { id: 't1', loc: 'srv:msg' }, name: 'p1: feature' },
    ]);
    expect(Object.keys(edge)).toEqual(['id', 'loc', 'rel']);
    expect(edge).toEqual({ id: 't1', loc: 'srv:msg', rel: 'p1: feature' });
  });

  it('omits loc when unknown, and renders a null name as empty rel', () => {
    const [edge] = buildEdgeFrontmatter([{ target: { id: 't1' }, name: null }]);
    expect(edge).toEqual({ id: 't1', rel: '' });
  });

  it('emits condition and non-zero priority when set, omits both at their defaults', () => {
    const condition = { '==': [{ var: 'agent.role' }, 'mentor'] };
    const [gated] = buildEdgeFrontmatter([
      { target: { id: 't1', loc: 'a:b' }, name: 'r', condition, priority: 5 },
    ]);
    expect(gated).toEqual({ id: 't1', loc: 'a:b', rel: 'r', condition, priority: 5 });

    // condition null + priority 0 (the DB default) → both omitted.
    const [plain] = buildEdgeFrontmatter([
      { target: { id: 't1' }, name: 'r', condition: null, priority: 0 },
    ]);
    expect(plain).toEqual({ id: 't1', rel: 'r' });
  });

  it('emits edgeLoc and runnable in the CLI key order, omitting runnable when false', () => {
    // Full shape, exercising the CLI-aligned order: id, loc, rel, edgeLoc,
    // description, data, runnable, condition, priority.
    const condition = { '==': [1, 1] };
    const [full] = buildEdgeFrontmatter([
      {
        target: { id: 't1', loc: 'a:b' },
        name: 'gated',
        loc: 'src:edge:01',
        description: 'why',
        data: { weight: 3 },
        isRunnable: true,
        condition,
        priority: 3,
      },
    ]);
    expect(Object.keys(full)).toEqual(['id', 'loc', 'rel', 'edgeLoc', 'description', 'data', 'runnable', 'condition', 'priority']);
    expect(full).toEqual({
      id: 't1', loc: 'a:b', rel: 'gated', edgeLoc: 'src:edge:01',
      description: 'why', data: { weight: 3 }, runnable: true, condition, priority: 3,
    });

    // runnable:false is the DB default → omitted entirely (matches the CLI's
    // `omitempty` bool); edgeLoc omitted when the edge has no own loc.
    const [plain] = buildEdgeFrontmatter([{ target: { id: 't1' }, name: 'r', isRunnable: false }]);
    expect(plain).toEqual({ id: 't1', rel: 'r' });
  });

  it('skips an edge with a missing target instead of throwing the whole push', () => {
    // target is a required FK (type-impossible to be null), but the runtime
    // guard must not crash the sync if a partial edge ever appears.
    const edges: EdgeForGit[] = [
      { target: null as unknown as EdgeForGit['target'], name: 'orphan' },
      { target: { id: 't1' }, name: 'ok' },
    ];
    expect(buildEdgeFrontmatter(edges)).toEqual([{ id: 't1', rel: 'ok' }]);
  });
});

describe('nodeFilePath', () => {
  it('writes a parent like a leaf — <seg>.md beside its <seg>/ folder, no README', () => {
    expect(nodeFilePath('/g', 'srv:msg:010:02')).toBe('/g/srv/msg/010/02.md');
    expect(nodeFilePath('/g', 'srv:msg:010:02:04')).toBe('/g/srv/msg/010/02/04.md');
  });

  it('maps the empty-loc root to repo-root README.md', () => {
    expect(nodeFilePath('/g', '')).toBe('/g/README.md');
  });

  it('throws on a malformed loc (empty / . / .. segment) — path-traversal guard', () => {
    expect(() => nodeFilePath('/g', 'a::b')).toThrow();    // empty middle segment
    expect(() => nodeFilePath('/g', 'a:b:')).toThrow();    // trailing colon
    expect(() => nodeFilePath('/g', 'a:..:b')).toThrow();  // path traversal
    expect(() => nodeFilePath('/g', ':')).toThrow();
  });
});

describe('orphanedLegacyPaths', () => {
  it('points at the old parent README and the old edge sidecar dir', () => {
    expect(orphanedLegacyPaths('/g', 'srv:msg:010:02')).toEqual({
      readme: '/g/srv/msg/010/02/README.md',
      sidecar: '/g/srv/msg/010/.02',
    });
  });

  it('throws on a malformed loc instead of resolving the sidecar to a parent dir', () => {
    // ':' would collapse the sidecar to localPath itself → a recursive delete
    // of the repo root; a trailing ':' → the node's own child folder.
    expect(() => orphanedLegacyPaths('/g', ':')).toThrow();
    expect(() => orphanedLegacyPaths('/g', 'srv:msg:010:02:')).toThrow();
    expect(() => orphanedLegacyPaths('/g', 'a::b')).toThrow();
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

  it('round-trips type: link → isLink: true, and default info → isLink: false', async () => {
    // The bulk path used to drop `type`, so re-imports flipped every link
    // node's isLink to false. Lock the round-trip down for both cases.
    const linkFm = buildNodeFrontmatter({ id: 'l1', name: 'A link', tags: [], nodeType: 'link' });
    expect(linkFm.type).toBe('link');
    const linkPath = join(graphRoot, 'lnk.md');
    writeFileSync(linkPath, `---\n${stringify(linkFm, { lineWidth: 0 }).trim()}\n---\n\nbody\n`, 'utf-8');
    const { node: linkNode } = await loadNodeFromFs(linkPath, graphRoot, 'org/repo');
    expect(linkNode.isLink).toBe(true);

    const infoFm = buildNodeFrontmatter({ id: 'i1', name: 'An info node', tags: [], nodeType: 'info' });
    expect(infoFm).not.toHaveProperty('type');
    const infoPath = join(graphRoot, 'inf.md');
    writeFileSync(infoPath, `---\n${stringify(infoFm, { lineWidth: 0 }).trim()}\n---\n\nbody\n`, 'utf-8');
    const { node: infoNode } = await loadNodeFromFs(infoPath, graphRoot, 'org/repo');
    expect(infoNode.isLink).toBe(false);
  });

  it('loads a parent (02.md) and its child (02/04.md) with inline edges via loadGraphFromFs', async () => {
    // The new layout: a parent is `<seg>.md` beside its `<seg>/` folder (no
    // README), and edges live inline in `nodes:` (no sidecar). Exercise the
    // real export builders + path helper, then load the whole tree back.
    const parentFm = buildNodeFrontmatter(
      { id: 'id02', name: 'W2', tags: ['spec'] },
      [
        { target: { id: 'id010', loc: 'srv:msg:010' }, name: 'p1: parent' },
        { target: { id: 'id00', loc: 'srv:msg:010:00' }, name: 'inherits' },
      ],
    );
    const childFm = buildNodeFrontmatter(
      { id: 'id04', name: 'Deep link', tags: ['spec'] },
      [{ target: { id: 'id02', loc: 'srv:msg:010:02' }, name: 'p2: flow' }],
    );

    const parentPath = nodeFilePath(graphRoot, 'srv:msg:010:02');
    const childPath = nodeFilePath(graphRoot, 'srv:msg:010:02:04');
    expect(parentPath.endsWith('srv/msg/010/02.md')).toBe(true);
    expect(childPath.endsWith('srv/msg/010/02/04.md')).toBe(true);
    mkdirSync(dirname(parentPath), { recursive: true });
    mkdirSync(dirname(childPath), { recursive: true });
    writeFileSync(parentPath, `---\n${stringify(parentFm, { lineWidth: 0 }).trim()}\n---\n\nparent body\n`, 'utf-8');
    writeFileSync(childPath, `---\n${stringify(childFm, { lineWidth: 0 }).trim()}\n---\n\nchild body\n`, 'utf-8');

    const { graph, edges } = await loadGraphFromFs(graphRoot, 'specs', 'org/repo');
    expect(graph.nodes.map((n) => n.loc).sort()).toEqual([
      'srv:msg:010:02',
      'srv:msg:010:02:04',
    ]);
    // Inline `nodes:` edges survived — no sidecar was written or read.
    expect(edges).toContainEqual(
      expect.objectContaining({ sourceId: 'id02', targetId: 'id010', name: 'p1: parent' }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ sourceId: 'id04', targetId: 'id02', name: 'p2: flow' }),
    );
  });

  it('migration: cleanup removes the old parent README + stale sidecar so fresh inline edges win', async () => {
    // Reproduce an old-format on-disk node: parent `02/README.md` plus a
    // stale `.02/edges.yaml` sidecar. The importer gives the sidecar
    // PRECEDENCE over inline `nodes:`, so without cleanup the stale edge
    // would mask the fresh one — this is why `orphanedLegacyPaths` removal is
    // mandatory.
    const oldParentDir = join(graphRoot, 'srv', 'msg', '010', '02');
    const oldSidecarDir = join(graphRoot, 'srv', 'msg', '010', '.02');
    mkdirSync(oldParentDir, { recursive: true });
    mkdirSync(oldSidecarDir, { recursive: true });
    writeFileSync(join(oldParentDir, 'README.md'), `---\nname: W2\nid: id02\n---\n\nold body\n`, 'utf-8');
    writeFileSync(join(oldSidecarDir, 'edges.yaml'), stringify([{ id: 'STALE', rel: 'stale edge' }]), 'utf-8');

    // Simulate the new writer: write the self-contained `02.md` with a fresh
    // inline edge, then run the exact cleanup the git writers perform.
    const newPath = nodeFilePath(graphRoot, 'srv:msg:010:02');
    const fm = buildNodeFrontmatter({ id: 'id02', name: 'W2', tags: [] }, [
      { target: { id: 'id010', loc: 'srv:msg:010' }, name: 'p1: parent' },
    ]);
    writeFileSync(newPath, `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n\nnew body\n`, 'utf-8');
    const legacy = orphanedLegacyPaths(graphRoot, 'srv:msg:010:02');
    rmSync(legacy.readme, { force: true });
    rmSync(legacy.sidecar, { recursive: true, force: true });

    expect(existsSync(join(oldParentDir, 'README.md'))).toBe(false);
    expect(existsSync(oldSidecarDir)).toBe(false);

    const { graph, edges } = await loadGraphFromFs(graphRoot, 'specs', 'org/repo');
    // The loc resolves to exactly one node (no duplicate README + 02.md).
    expect(graph.nodes.filter((n) => n.loc === 'srv:msg:010:02')).toHaveLength(1);
    // The fresh inline edge won; the stale sidecar edge is gone.
    expect(edges).toContainEqual(
      expect.objectContaining({ sourceId: 'id02', targetId: 'id010', name: 'p1: parent' }),
    );
    expect(edges.some((e) => e.targetId === 'STALE')).toBe(false);
  });

  it('round-trips edge condition + priority through the inline nodes: array', async () => {
    const condition = { '==': [{ var: 'agent.role' }, 'mentor'] };
    const fm = buildNodeFrontmatter({ id: 'src1', name: 'Source', tags: [] }, [
      { target: { id: 'tgt1', loc: 'a:b' }, name: 'gated', condition, priority: 7 },
    ]);
    const mdPath = nodeFilePath(graphRoot, 'a');
    writeFileSync(mdPath, `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n\nbody\n`, 'utf-8');

    const { edges } = await loadGraphFromFs(graphRoot, 'specs', 'org/repo');
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceId: 'src1',
        targetId: 'tgt1',
        name: 'gated',
        condition,
        priority: 7,
      }),
    );
  });

  it('round-trips edge data and an empty description through a fresh graph load', async () => {
    const fm = buildNodeFrontmatter({ id: 'src1', name: 'Source', tags: [] }, [
      {
        target: { id: 'tgt1', loc: 'target' },
        name: 'uses',
        description: '',
        data: { weight: 3 },
      },
    ]);
    const mdPath = nodeFilePath(graphRoot, 'source');
    writeFileSync(mdPath, `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n\nbody\n`, 'utf-8');

    const { edges } = await loadGraphFromFs(graphRoot, 'specs', 'org/repo');
    expect(edges).toContainEqual(expect.objectContaining({
      sourceId: 'src1', targetId: 'tgt1', name: 'uses',
      description: '', data: { weight: 3 },
    }));
  });

  it('round-trips a runnable edge via the `runnable` key written by the builder', async () => {
    const fm = buildNodeFrontmatter({ id: 'src1', name: 'Source', tags: [] }, [
      { target: { id: 'tgt1', loc: 'a:b' }, name: 'runs', isRunnable: true },
    ]);
    // The exported file uses `runnable:` (CLI parity), not the legacy `isRunnable:`.
    const fmYaml = stringify(fm, { lineWidth: 0 });
    expect(fmYaml).toContain('runnable: true');
    expect(fmYaml).not.toContain('isRunnable');

    const mdPath = nodeFilePath(graphRoot, 'a');
    writeFileSync(mdPath, `---\n${fmYaml.trim()}\n---\n\nbody\n`, 'utf-8');
    const { edges } = await loadGraphFromFs(graphRoot, 'specs', 'org/repo');
    expect(edges).toContainEqual(
      expect.objectContaining({ sourceId: 'src1', targetId: 'tgt1', name: 'runs', isRunnable: true }),
    );
  });

  it('still imports the legacy `isRunnable` key from already-pushed mirrors', async () => {
    // A hand-written file in the OLD format (server used to emit `isRunnable`).
    const legacy =
      '---\nname: Source\nid: src1\nnodes:\n  - id: tgt1\n    loc: a:b\n    rel: runs\n    isRunnable: true\n---\n\nbody\n';
    const mdPath = nodeFilePath(graphRoot, 'a');
    writeFileSync(mdPath, legacy, 'utf-8');
    const { edges } = await loadGraphFromFs(graphRoot, 'specs', 'org/repo');
    expect(edges).toContainEqual(
      expect.objectContaining({ sourceId: 'src1', targetId: 'tgt1', name: 'runs', isRunnable: true }),
    );
  });
});

describe('derived include edges (#2040)', () => {
  it('are never mirrored into the nodes: frontmatter', () => {
    const entries = buildEdgeFrontmatter([
      { governedKind: 'INCLUDE', target: { id: 'b', loc: 'b' }, name: 'includes', loc: 'includes:a:b' },
      { target: { id: 'c', loc: 'c' }, name: 'cites', loc: 'a:cites:c' },
    ]);
    expect(entries.map((e) => e.id)).toEqual(['c']);
  });
});
