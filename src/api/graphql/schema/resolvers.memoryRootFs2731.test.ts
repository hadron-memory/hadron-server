import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { createNode } from '../../../controller/operations/createNode.js';
import { resolvers, type Context } from './resolvers.js';
import { withFsProjectionRollback } from '../../../lib/fsProjectionRollback.js';
import * as defaults from './resolvers.memoryConfigOrgDefault.js';

// Database atomicity remains; old projection ownership/snapshot restoration is
// retired rather than ported to a replacement filesystem layout.
const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'root-atomic-')) };
});
vi.mock('../../../config.js', async original => ({ ...await original<typeof import('../../../config.js')>(), GRAPHS_PATH: fixture.root }));
afterAll(async () => { const { rmSync } = await import('node:fs'); rmSync(fixture.root, { recursive: true, force: true }); });
afterEach(() => vi.restoreAllMocks());
const M = resolvers.Mutation;
let org: any, admin: any, app: any, agent: any, mem: any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
const yaml = (loc: string) => join(fixture.root, ...loc.split(':'), '.node', 'node.yaml');
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Root atomic', urn: 'fs2731.test' } });
  admin = await db.user.create({ data: { githubId: 273100, githubUsername: 'u2731', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { name: 'Helper', urn: `${org.urn}:helper`, organizationId: org.id } });
  app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id, appAgents: { create: { agentId: agent.id } } } });
  mem = await db.memory.create({ data: { name: 'Host2731', urn: `${org.urn}:host2731`, organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION' } });
});
it('a caller transaction needs no filesystem rollback scope and remains atomic', async () => {
  await expect(db.$transaction(async tx => {
    await createNode({ memoryId: mem.id, loc: 'raw2731', name: 'root' }, tx);
    throw new Error('synthetic caller rollback');
  })).rejects.toThrow('synthetic caller rollback');
  expect(await db.node.count({ where: { memoryId: mem.id } })).toBe(0);
  expect(existsSync(yaml('raw2731'))).toBe(false);
});
it('the compatibility wrapper preserves the original failure and database rollback', async () => {
  await expect(withFsProjectionRollback(() => db.$transaction(async tx => {
    await createNode({ memoryId: mem.id, loc: 'wrapped2731', name: 'root' }, tx);
    throw new Error('synthetic wrapped rollback');
  }))).rejects.toThrow('synthetic wrapped rollback');
  expect(await db.node.count({ where: { memoryId: mem.id } })).toBe(0);
  expect(existsSync(yaml('wrapped2731'))).toBe(false);
});
it.each([false, true])('success and failed re-save preserve existing filesystem bytes (%s)', async fail => {
  const loc = `prior2731-${fail}`;
  mkdirSync(join(fixture.root, loc, '.node'), { recursive: true });
  writeFileSync(yaml(loc), 'synthetic prior yaml');
  writeFileSync(join(fixture.root, loc, '.node', 'topic.md'), 'synthetic prior topic');
  if (fail) await expect(createNode({ memoryId: 'does-not-exist', loc, name: 'root' })).rejects.toThrow();
  else await createNode({ memoryId: mem.id, loc, name: 'root' });
  expect(readFileSync(yaml(loc), 'utf8')).toBe('synthetic prior yaml');
  expect(readFileSync(join(fixture.root, loc, '.node', 'topic.md'), 'utf8')).toBe('synthetic prior topic');
});
it('an own-transaction database failure creates no filesystem residue', async () => {
  await expect(createNode({ memoryId: 'does-not-exist', loc: 'missing2731:child', name: 'child' })).rejects.toThrow();
  expect(existsSync(join(fixture.root, 'missing2731'))).toBe(false);
});
for (const door of ['memory', 'installed', 'app'] as const) describe(`database rollback ${door}`, () => {
  const create = () => door === 'memory' ? M.createMemory({}, { name: `Root-${door}`, orgRef: org.id }, ctx())
    : door === 'app' ? M.createAppMemory({}, { name: `Root-${door}`, appRef: app.id }, ctx())
    : M.createMemoryInApp({}, { name: `Root-${door}`, appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge' }, ctx());
  it('creates one memory and no root node, and writes no projection (#3952)', async () => {
    const before = await db.memory.count();
    const made = await create();
    expect(await db.memory.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ organizationId: org.id });
    expect(await db.memory.count()).toBe(before + 1);
    expect(await db.node.count({ where: { memoryId: made.id } })).toBe(0);
    expect(existsSync(yaml(`Root-${door}`))).toBe(false);
  });
  // The failure is injected at the org-default step, which only the memory door runs. The installed door's rollback
  // (agent grant) and the group owner row are pinned in resolvers.noRootNode3952.test.ts; the app door writes only the
  // memory row, so it has nothing to roll back.
  it.runIf(door === 'memory')('a later failure rolls its memory back, and a retry creates exactly one', async () => {
    const before = await db.memory.count();
    vi.spyOn(defaults, 'applyOrgDefaultsAtCreation').mockRejectedValueOnce(new Error('synthetic database failure'));
    await expect(create()).rejects.toThrow('synthetic database failure');
    expect(await db.memory.count()).toBe(before);
    await create();
    expect(await db.memory.count()).toBe(before + 1);
  });
});
