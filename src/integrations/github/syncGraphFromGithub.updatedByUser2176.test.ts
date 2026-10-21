/**
 * #2176: a git sync is a SYSTEM write. Run inside a user's request, as the `hadron_sync_graph` MCP tool runs it, the
 * real sync write path clears the node's updatedByUser, and a sibling write after it in the same request still
 * records that user (the system scope never mutates the request's holder).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { emptyActor, publishUser, requestActorStorage } from '../../lib/requestActor.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string) => source),
}));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
vi.mock('../../config.js', async (original) => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));

const syncedId = 'aaaa2176000000000000000000000001';
let userId: string;

const asUser = <T>(fn: () => Promise<T>) => requestActorStorage.run(emptyActor(), async () => {
  publishUser(userId);
  return fn();
});

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'sync-user' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:sync-user', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
  userId = (await db.user.create({ data: { handle: 'sync-editor', roles: ['READER'] } })).id;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('#2176 hadron_sync_graph is a system write', () => {
  it('clears updatedByUser on the synced node, and a sibling user write in the same request keeps the user', async () => {
    await db.node.create({ data: { id: syncedId, memoryId: graph.id, loc: 'synced', name: 'Before', content: 'Old body', ownerRepo: 'test/repo' } });
    const sibling = await db.node.create({ data: { memoryId: graph.id, loc: 'sibling', name: 'Sibling' } });
    await asUser(() => db.node.update({ where: { id: syncedId }, data: { name: 'Edited by user' } }));
    expect((await db.node.findUniqueOrThrow({ where: { id: syncedId } })).updatedByUserId).toBe(userId);

    const repo = join(graphsPath, 'test-org', 'sync-user');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'synced.md'), `---\nid: ${syncedId}\nname: From git\n---\nNew body`);

    await asUser(async () => {
      expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
      await db.node.update({ where: { id: sibling.id }, data: { name: 'Sibling edited' } });
    });

    const synced = await db.node.findUniqueOrThrow({ where: { id: syncedId } });
    expect(synced).toMatchObject({ name: 'From git', updatedByUserId: null, updatedByWorkerId: null, updatedByAgentId: null });
    expect((await db.node.findUniqueOrThrow({ where: { id: sibling.id } })).updatedByUserId).toBe(userId);
  });
});
