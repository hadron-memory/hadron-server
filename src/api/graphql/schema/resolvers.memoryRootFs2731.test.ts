import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { GRAPHS_PATH } from '../../../config.js';
import { createNode } from '../../../controller/operations/createNode.js';
import { resolvers, type Context } from './resolvers.js';
import { withFsProjectionRollback } from '../../../lib/fsProjectionRollback.js';
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
  it('a raw caller transaction with no rollback scope is refused before anything is written', async () => {
    const loc = 'raw2731';
    await expect(db.$transaction(async (tx) => {
      await createNode({ memoryId: mem.id, loc, name: loc }, tx);
    })).rejects.toThrow(/withFsProjectionRollback/);
    expect(existsSync(yaml(loc))).toBe(false);
  });
  it('rollback never deletes a topic.md this call did not write', async () => {
    const loc = 'topic2731';
    mkdirSync(join(GRAPHS_PATH, loc, '.node'), { recursive: true });
    writeFileSync(join(GRAPHS_PATH, loc, '.node', 'topic.md'), 'earlier topic');
    await expect(createNode({ memoryId: 'does-not-exist', loc, name: loc })).rejects.toThrow();
    expect(readFileSync(join(GRAPHS_PATH, loc, '.node', 'topic.md'), 'utf-8')).toBe('earlier topic');
    expect(existsSync(yaml(loc))).toBe(false);
  });
  it("rollback leaves a projection another create overwrote (the winner's), and restores a failed re-save's prior bytes", async () => {
    const loc = 'race2731';
    await expect(withFsProjectionRollback(() => db.$transaction(async (tx) => {
      await createNode({ memoryId: mem.id, loc, name: 'loser' }, tx);
      writeFileSync(yaml(loc), 'id: winner\nname: winner\n'); // a concurrent commit's projection lands over ours
      throw new Error('loser fails');
    }))).rejects.toThrow('loser fails');
    expect(readFileSync(yaml(loc), 'utf-8')).toBe('id: winner\nname: winner\n');
    const loc2 = 'resave2731b';
    await createNode({ memoryId: mem.id, loc: loc2, name: 'first' });
    const first = readFileSync(yaml(loc2), 'utf-8');
    await expect(createNode({ memoryId: 'does-not-exist', loc: loc2, name: 'second' })).rejects.toThrow();
    expect(readFileSync(yaml(loc2), 'utf-8')).toBe(first);
  });
  it('a caller transaction that rolls back leaves no node.yaml', async () => {
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
  it('a partial fs failure (yaml written, topic write throws) leaves no node.yaml', async () => {
    const loc = 'partial2731';
    mkdirSync(join(GRAPHS_PATH, loc, '.node', 'topic.md'), { recursive: true }); // a directory where topic.md must go
    await expect(createNode({ memoryId: mem.id, loc, name: loc, content: 'body' })).rejects.toThrow(/filesystem/);
    expect(existsSync(yaml(loc))).toBe(false);
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
    await withFsProjectionRollback(() => db.$transaction(async (tx) => {
      await createNode({ memoryId: mem.id, loc, name: loc }, tx);
      seenAtInsert = existsSync(yaml(loc));
    }));
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

it('two identical-field creates at one loc in different orgs: the loser rolling back leaves the committed winner projection', async () => {
  const orgB = await db.organization.create({ data: { name: 'Fs orphan B', urn: 'fs2731b.test' } });
  const memB = await db.memory.create({ data: { name: 'B2731', urn: `${orgB.urn}:b2731`, organizationId: orgB.id, class: 'knowledge', visibility: 'ORGANIZATION' } });
  const loc = 'twoorg2731';
  await expect(withFsProjectionRollback(() => db.$transaction(async (tx) => {
    await createNode({ memoryId: mem.id, loc, name: 'same', description: 'Root node for this memory.' }, tx); // A projects
    await createNode({ memoryId: memB.id, loc, name: 'same', description: 'Root node for this memory.' }); // B writes the same fields, commits
    throw new Error('A aborts');
  }))).rejects.toThrow('A aborts');
  expect(existsSync(yaml(loc))).toBe(true);
  expect(readFileSync(yaml(loc), 'utf-8')).toContain((await db.node.findFirstOrThrow({ where: { memoryId: memB.id, loc } })).id);
});

it('same loc and identical topic bytes: the loser rolling back leaves the committed winner topic.md', async () => {
  const orgB = await db.organization.create({ data: { name: 'Fs orphan C', urn: 'fs2731c.test' } });
  const memB = await db.memory.create({ data: { name: 'C2731', urn: `${orgB.urn}:c2731`, organizationId: orgB.id, class: 'knowledge', visibility: 'ORGANIZATION' } });
  const loc = 'topicrace2731';
  await expect(withFsProjectionRollback(() => db.$transaction(async (tx) => {
    await createNode({ memoryId: mem.id, loc, name: 'same', content: 'shared body' }, tx);
    await createNode({ memoryId: memB.id, loc, name: 'same', content: 'shared body' });
    throw new Error('A aborts');
  }))).rejects.toThrow('A aborts');
  expect(readFileSync(join(GRAPHS_PATH, loc, '.node', 'topic.md'), 'utf-8')).toBe('shared body');
  expect(existsSync(yaml(loc))).toBe(true);
});
