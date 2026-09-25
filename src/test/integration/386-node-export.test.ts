/**
 * Integration test for the nodeExport resolver (#386): exercises the real
 * resolver against the test DB — auth gate, field mapping, edge inclusion,
 * round-trip through the importer, and section selection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb, makeTmpDir } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { loadNodeFromFs } from '../../integrations/localFs/loadNodeFromFs.js';

const nodeExport = (resolvers.Query as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>)
  .nodeExport;

interface ExportResult {
  format: string;
  mimeType: string;
  filename: string;
  encoding: string;
  data: string;
  bytes: number;
}

interface Fx {
  memoryUrn: string;
  srcId: string;
  strangerId: string;
}

async function build(): Promise<Fx> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'ExportOrg', urn: 'exportorg' } });
  const memoryUrn = 'exportorg:kb';
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: memoryUrn, name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const src = await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: 'guide:intro', name: 'Intro',
      nodeType: 'task', description: 'One-liner', abstract: 'A longer summary.',
      content: '# Intro\n\nBody.', tags: ['guide', 'intro'], seq: 0,
    },
  });
  const tgt = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'guide:more', name: 'More', tags: [] },
  });
  await db.edge.create({
    data: {
      id: generateId(), memoryId: memory.id, sourceId: src.id, targetId: tgt.id,
      loc: 'guide:intro:next:guide:more', name: 'next', priority: 5, isRunnable: true,
    },
  });

  // A user in a *different* org — no access to exportorg's memory.
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: 'otherorg' } });
  const stranger = await db.user.create({ data: { id: generateId(), githubId: 99001, githubUsername: 'stranger' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: stranger.id, role: 'OWNER' } });

  return { memoryUrn, srcId: src.id, strangerId: stranger.id };
}

const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: generateId() });

describe('#386 nodeExport resolver', () => {
  let fx: Fx;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await build();
  });

  it('renders canonical MD with loc/memory/contentHash + edge (edgeLoc, runnable), and round-trips', async () => {
    const r = (await nodeExport(null, { id: fx.srcId, format: 'MD', full: true }, adminCtx())) as ExportResult;
    expect(r.format).toBe('MD');
    expect(r.mimeType).toBe('text/markdown');
    expect(r.filename).toBe('intro.md'); // loc leaf
    expect(r.encoding).toBe('TEXT');
    expect(r.bytes).toBe(Buffer.byteLength(r.data, 'utf8'));

    // Standalone keys + the aligned edge frontmatter (#387 keys).
    expect(r.data).toContain('\nloc: guide:intro\n');
    expect(r.data).toContain(`\nmemory: ${fx.memoryUrn}\n`);
    expect(r.data).toContain('\ncontentHash: ');
    expect(r.data).toContain('edgeLoc: guide:intro:next:guide:more');
    expect(r.data).toContain('runnable: true');
    expect(r.data).not.toContain('isRunnable');

    // Round-trip through the importer.
    const { dir, cleanup } = makeTmpDir();
    try {
      const mdPath = join(dir, 'intro.md');
      mkdirSync(dirname(mdPath), { recursive: true });
      writeFileSync(mdPath, r.data, 'utf-8');
      const { node, edges } = await loadNodeFromFs(mdPath, dir, 'org/repo');
      expect(node.name).toBe('Intro');
      expect(node.abstract).toBe('A longer summary.');
      expect(node.content).toBe('# Intro\n\nBody.');
      expect(edges).toContainEqual(expect.objectContaining({ name: 'next', isRunnable: true }));
    } finally {
      cleanup();
    }
  });

  it('renders canonical JSON with the full Document shape', async () => {
    const r = (await nodeExport(null, { id: fx.srcId, format: 'JSON', full: true }, adminCtx())) as ExportResult;
    expect(r.mimeType).toBe('application/json');
    expect(r.filename).toBe('intro.json');
    const doc = JSON.parse(r.data);
    expect(doc.memory).toBe(fx.memoryUrn);
    expect(doc.loc).toBe('guide:intro');
    expect(doc.type).toBe('task');
    expect(doc.contentHash).toMatch(/^[0-9a-f]{8}$/);
    expect(doc.content).toBe('# Intro\n\nBody.');
    expect(doc.edges[0]).toMatchObject({ targetId: expect.any(String), name: 'next', priority: 5, isRunnable: true });
    expect(doc.edges[0].edgeLoc ?? doc.edges[0].loc).toBe('guide:intro:next:guide:more');
  });

  it('honors section selection (full: false) — CONTENT only returns just the body', async () => {
    const r = (await nodeExport(null, { id: fx.srcId, format: 'MD', full: false, sections: ['CONTENT'] }, adminCtx())) as ExportResult;
    expect(r.data).toBe('# Intro\n\nBody.\n');
  });

  // #1340: a server export used to drop the node's kind, so re-importing a
  // spec made an info node. The file now carries role/isRunnable/objectType as
  // the git mirror and CLI codec do, and the loader reads them back. (Whether
  // git-sync then PERSISTS objectType is #1348, a separate importer defect.)
  it.each([
    ['spec', { role: 'spec', isRunnable: null, objectType: null }],
    ['review, explicitly not runnable', { role: 'review', isRunnable: false, objectType: null }],
    ['runnable task with an objectType', { role: null, isRunnable: true, objectType: 'competitor' }],
    ['custom dotted role', { role: 'acme.playbook', isRunnable: true, objectType: 'insight' }],
  ] as const)('#1340 — %s: MD and JSON carry the kind, and the MD round-trips through the loader', async (_n, kind) => {
    await db.node.update({ where: { id: fx.srcId }, data: kind });

    const json = JSON.parse(
      ((await nodeExport(null, { id: fx.srcId, format: 'JSON', full: true }, adminCtx())) as ExportResult).data,
    );
    expect({ role: json.role, isRunnable: json.isRunnable, objectType: json.objectType }).toEqual({
      ...kind, objectType: kind.objectType ?? '',
    });

    const md = ((await nodeExport(null, { id: fx.srcId, format: 'MD', full: true }, adminCtx())) as ExportResult).data;
    const { dir, cleanup } = makeTmpDir();
    try {
      const mdPath = join(dir, 'intro.md');
      writeFileSync(mdPath, md, 'utf-8');
      // The loader returns the governed signals, but its declared type (the
      // legacy `Partial<Node>`) predates them.
      const { node } = (await loadNodeFromFs(mdPath, dir, 'org/repo')) as unknown as {
        node: { role?: string | null; isRunnable?: boolean | null; objectType?: string | null };
      };
      expect({ role: node.role ?? null, isRunnable: node.isRunnable ?? null, objectType: node.objectType ?? null }).toEqual(kind);
    } finally {
      cleanup();
    }
  });

  it('#1340 — an objectType stored as "" (not NULL) is omitted from MD and "" in JSON (@jonas, #1778)', async () => {
    await db.node.update({ where: { id: fx.srcId }, data: { objectType: '' } });
    const md = ((await nodeExport(null, { id: fx.srcId, format: 'MD', full: true }, adminCtx())) as ExportResult).data;
    expect(md).not.toContain('objectType');
    const json = JSON.parse(
      ((await nodeExport(null, { id: fx.srcId, format: 'JSON', full: true }, adminCtx())) as ExportResult).data,
    );
    expect(json.objectType).toBe('');
  });

  it('#1340 — an ordinary node carries no opinion: nothing in MD, null/"" in JSON', async () => {
    const md = ((await nodeExport(null, { id: fx.srcId, format: 'MD', full: true }, adminCtx())) as ExportResult).data;
    for (const key of ['\nrole:', '\nrunnable:', '\nobjectType:']) expect(md, key).not.toContain(key);
    const json = JSON.parse(
      ((await nodeExport(null, { id: fx.srcId, format: 'JSON', full: true }, adminCtx())) as ExportResult).data,
    );
    expect({ role: json.role, isRunnable: json.isRunnable, objectType: json.objectType }).toEqual({
      role: null, isRunnable: null, objectType: '',
    });
  });

  it('denies a caller who cannot read the node\'s memory (NOT_FOUND)', async () => {
    const strangerCtx: Context = { db, roles: ['READER'], userId: fx.strangerId };
    await expect(nodeExport(null, { id: fx.srcId, format: 'MD', full: true }, strangerCtx)).rejects.toThrow(/not found/i);
  });
});
