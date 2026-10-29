import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { GRAPHS_PATH } from '../../../config.js';
import { createNode } from '../../../controller/operations/createNode.js';
import { resolvers, type Context } from './resolvers.js';
import * as locks from '../../../lib/nodeSubtreeLock.js';
import * as rootFs from '../../../integrations/localFs/saveNodeToFs.js';

// #2731: a rolled-back or failed node create must not leave `<GRAPHS_PATH>/<loc>/.node/node.yaml` behind,
// while an fs failure still fails creation with no row and a success still projects.
afterEach(() => vi.restoreAllMocks());
const M = resolvers.Mutation as any;
let org: any, admin: any, app: any, agent: any, mem: any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
const yaml = (loc: string) => join(GRAPHS_PATH, ...loc.split(':'), '.node', 'node.yaml');

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Fs orphan', urn: 'fs2731.test' } });
  admin = await db.user.create({ data: { githubId: 273100, githubUsername: 'u2731', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { name: 'Helper', urn: `${org.urn}:helper`, organizationId: org.id } });
  app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id, appAgents: { create: { agentId: agent.id } } } });
  mem = await db.memory.create({ data: { name: 'Host2731', urn: `${org.urn}:host2731`, organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION' } });
});

describe('createNode seam', () => {
  it('a caller transaction that rolls back leaves no node.yaml', async () => {
    const { withFsProjectionRollback } = await import('../../../lib/fsProjectionRollback.js');
    const loc = 'rollback2731';
    await expect(withFsProjectionRollback(() => db.$transaction(async (tx) => {
      await createNode({ memoryId: mem.id, loc, name: loc }, tx);
      expect(existsSync(yaml(loc))).toBe(true);
      throw new Error('forced rollback');
    }))).rejects.toThrow('forced rollback');
    expect(await db.node.count({ where: { loc, memoryId: mem.id } })).toBe(0);
    expect(existsSync(yaml(loc))).toBe(false);
  });
  it('a DB failure after the fs write (own transaction) leaves no node.yaml', async () => {
    const loc = 'fk2731:child';
    await expect(createNode({ memoryId: 'does-not-exist', loc, name: 'child' })).rejects.toThrow();
    expect(existsSync(yaml(loc))).toBe(false);
    expect(existsSync(join(GRAPHS_PATH, 'fk2731'))).toBe(false);
  });
  it('an fs failure still fails creation with no row', async () => {
    vi.spyOn(rootFs, 'saveNodeToFs').mockResolvedValueOnce({ error: 'injected' });
    await expect(createNode({ memoryId: mem.id, loc: 'fsfail2731', name: 'x' })).rejects.toThrow('injected');
    expect(await db.node.count({ where: { loc: 'fsfail2731', memoryId: mem.id } })).toBe(0);
  });
  it('a success still projects, and the projection is not removed', async () => {
    const loc = 'ok2731';
    await createNode({ memoryId: mem.id, loc, name: loc });
    expect(existsSync(yaml(loc))).toBe(true);
    expect(await db.node.count({ where: { loc, memoryId: mem.id } })).toBe(1);
  });
  it('a failed re-save does not delete an earlier projection', async () => {
    const loc = 'resave2731';
    await createNode({ memoryId: mem.id, loc, name: loc });
    await expect(createNode({ memoryId: 'does-not-exist', loc, name: loc })).rejects.toThrow();
    expect(existsSync(yaml(loc))).toBe(true);
  });
  it('the fs write happens before, not inside, the DB transaction', async () => {
    let seenAtInsert = false;
    const loc = 'order2731';
    await db.$transaction(async (tx) => {
      await createNode({ memoryId: mem.id, loc, name: loc }, tx);
      seenAtInsert = existsSync(yaml(loc));
    });
    expect(seenAtInsert).toBe(true);
  });
});

describe.each([
  ['createMemory', () => M.createMemory({}, { name: 'RollMem2731', orgId: org.id }, ctx()), 'RollMem2731'],
  ['createMemoryInApp', () => M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'RollApp2731' }, ctx()), 'RollApp2731'],
  ['createAppMemory', () => M.createAppMemory({}, { appRef: app.id, name: 'RollAppMem2731' }, ctx()), 'RollAppMem2731'],
])('%s', (_n, create, rootLoc) => {
  it('a failure after the root projection rolls the memory back and removes the file', async () => {
    // fails inside createNode's DB write, i.e. after saveNodeToFs ran
    vi.spyOn(locks, 'lockLocForWrite').mockRejectedValueOnce(new Error('injected after fs'));
    const before = await db.memory.count();
    await expect(create()).rejects.toThrow();
    expect(await db.memory.count()).toBe(before);
    expect(existsSync(yaml(rootLoc))).toBe(false);
  });
  it('a success keeps the projection', async () => {
    await create();
    expect(existsSync(yaml(rootLoc))).toBe(true);
  });
});
