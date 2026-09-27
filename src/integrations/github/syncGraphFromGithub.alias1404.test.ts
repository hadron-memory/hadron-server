/** #1404: Git mirror rewrites preserve only surviving node identities. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir, writeNodeFiles } from '../../test/helpers.js';
import { resolveNodeRef } from '../../lib/entityRef/nodeRef.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (error: null, stdout: string, stderr: string) => void;
    cb(null, '', '');
  }),
}));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string) => source),
}));

let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { ...real, get GRAPHS_PATH() { return graphsPath; } };
});

const repoRoot = () => join(graphsPath, 'test-org', 'test/repo');
const nodeUrn = (loc: string) => `hrn:node:${graph.urn}:${loc}`;
const aliasesFor = (nodeId: string) => db.urnAlias.findMany({
  where: { entityType: 'NODE', entityId: nodeId },
});
function file(loc: string, id: string): void {
  const dir = join(repoRoot(), ...loc.split(':'));
  mkdirSync(dir, { recursive: true });
  writeNodeFiles(dir, { id, name: loc });
}

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, {
    orgName: 'test-org', graphName: 'test/repo',
  });
  await db.organization.update({
    where: { id: org.id }, data: { githubInstallationId: 12345 },
  });
  graph = await db.memory.update({
    where: { id: created.id },
    data: { source: 'git@github.com:test/repo.git' },
    include: { organization: true },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('#1404 Git-sync node aliases', () => {
  it('resolves an old full URN after an id-first file rename', async () => {
    const id = 'aaaa1404000000000000000000000006';
    file('original', id);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    rmSync(join(repoRoot(), 'original'), { recursive: true });
    file('renamed', id);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();

    expect((await db.node.findUniqueOrThrow({ where: { id } })).loc).toBe('renamed');
    expect(await resolveNodeRef(db, nodeUrn('original'))).toEqual({ id });
  });

  it('records an old address when one file moves with the same node id', async () => {
    const id = 'aaaa1404000000000000000000000001';
    file('old', id);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    rmSync(join(repoRoot(), 'old'), { recursive: true });
    file('new', id);

    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();

    expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ loc: 'new' });
    expect((await aliasesFor(id)).map((a) => a.urn)).toEqual([`${graph.urn}:old`]);
    expect(await resolveNodeRef(db, nodeUrn('old'))).toEqual({ id });
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await aliasesFor(id)).toHaveLength(1);
  });

  it('records pre-sync addresses in a swap, while each live address names its new occupant', async () => {
    const a = 'aaaa1404000000000000000000000002';
    const b = 'bbbb1404000000000000000000000003';
    file('a', a);
    file('b', b);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    rmSync(join(repoRoot(), 'a'), { recursive: true });
    rmSync(join(repoRoot(), 'b'), { recursive: true });
    file('a', b);
    file('b', a);

    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();

    expect((await aliasesFor(a)).map((alias) => alias.urn)).toEqual([`${graph.urn}:a`]);
    expect((await aliasesFor(b)).map((alias) => alias.urn)).toEqual([`${graph.urn}:b`]);
    expect(await resolveNodeRef(db, nodeUrn('a'))).toEqual({ id: b });
    expect(await resolveNodeRef(db, nodeUrn('b'))).toEqual({ id: a });
  });

  it('does not alias a deleted occupant or a foreign-id copy to another identity', async () => {
    const deletedId = 'cccc1404000000000000000000000004';
    file('deleted', deletedId);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    rmSync(join(repoRoot(), 'deleted'), { recursive: true });
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: deletedId } })).toBeNull();
    expect(await aliasesFor(deletedId)).toEqual([]);

    const { graph: foreign } = await createDbOrgAndGraph(db, {
      orgName: 'foreign-org', graphName: 'foreign/repo',
    });
    const foreignId = 'dddd1404000000000000000000000005';
    await db.node.create({ data: {
      id: foreignId, memoryId: foreign.id, loc: 'original', name: 'original',
    } });
    file('copy', foreignId);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    const copy = await db.node.findFirstOrThrow({ where: { memoryId: graph.id, loc: 'copy' } });
    expect(copy.id).not.toBe(foreignId);
    expect(await aliasesFor(foreignId)).toEqual([]);
    expect(await aliasesFor(copy.id)).toEqual([]);
  });
});
