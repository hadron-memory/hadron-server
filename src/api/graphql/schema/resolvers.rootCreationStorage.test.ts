import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import * as defaults from './resolvers.memoryConfigOrgDefault.js';
import { memoryLocalPath } from '../../../integrations/github/gitMirrorCheckout.js';

const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'root-storage-')),
    observing: false, operations: [] as string[], write: vi.fn() };
});
vi.mock('../../../config.js', async original => ({ ...await original<typeof import('../../../config.js')>(), GRAPHS_PATH: fixture.root }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// Observe real filesystem operations only while the resolver runs. Removed export
// names cannot observe a new snapshot/restore implementation; these can.
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const observed = Object.fromEntries([
    'readFileSync', 'readdirSync', 'existsSync', 'mkdirSync',
    'writeFileSync', 'rmSync', 'rmdirSync',
  ].map(operation => [operation, (...args: any[]) => {
    const target = args[0];
    if (fixture.observing && typeof target === 'string' &&
        (target === fixture.root || target.startsWith(`${fixture.root}/`))) {
      fixture.operations.push(operation);
    }
    return (actual[operation as keyof typeof actual] as Function)(...args);
  }]));
  return { ...actual, ...observed };
});
vi.mock('../../../integrations/localFs/saveNodeToFs.js', async original => {
  const actual = await original<typeof import('../../../integrations/localFs/saveNodeToFs.js')>();
  return { ...actual, saveNodeToFs: (...args: Parameters<typeof actual.saveNodeToFs>) => {
    fixture.write(); return actual.saveNodeToFs(...args);
  } };
});
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));
const M = resolvers.Mutation;
let org: { id: string; urn: string }, app: { id: string }, agent: { id: string }, admin: { id: string }, plain: { id: string };
const context = (userId: string): Context => ({ db, userId, roles: [] });
type Door = 'personal' | 'organization' | 'app' | 'installed';
async function create(door: Door, name: string, denied = false) {
  const ctx = context(denied || door === 'personal' ? plain.id : admin.id);
  fixture.observing = true;
  try {
    if (door === 'personal') return await M.createMemory({}, { name, memoryClass: 'personal' }, ctx);
    if (door === 'organization') return await M.createMemory({}, { name, orgRef: org.id }, ctx);
    if (door === 'app') return await M.createAppMemory({}, { name, appRef: app.id }, ctx);
    return await M.createMemoryInApp({}, { name, appRef: app.id, agentRef: agent.id, memoryClass: 'app' }, ctx);
  } finally { fixture.observing = false; }
}
function snapshot(dir = fixture.root): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name), rel = relative(fixture.root, path);
    return entry.isDirectory() ? [`directory:${rel}`, ...snapshot(path)]
      : [`file:${rel}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`];
  });
}
function noParticipants() {
  expect(fixture.operations).toEqual([]);
  expect(fixture.write).not.toHaveBeenCalled();
}
beforeEach(async () => {
  await cleanDb(db);
  rmSync(fixture.root, { recursive: true, force: true }); mkdirSync(fixture.root);
  org = await db.organization.create({ data: { id: generateId(), name: 'synthetic owner', urn: 'owner-storage.test' } });
  agent = await db.agent.create({ data: { id: generateId(), name: 'agent', urn: `${org.urn}:agent`, organizationId: org.id } });
  app = (await createDbAppWithKey(db, 'storage-app', org.id)).app;
  await createDbAppAgent(db, app.id, agent.id);
  admin = await db.user.create({ data: { id: generateId(), handle: 'storage-admin', roles: [] } });
  plain = await db.user.create({ data: { id: generateId(), handle: 'storage-person', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const checkout = memoryLocalPath('other-storage.test', 'other-storage.test:notes');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'config'), 'synthetic config');
  writeFileSync(join(checkout, 'sentinel'), 'synthetic checkout');
  mkdirSync(join(fixture.root, 'other-storage.test', '.node'), { recursive: true });
  writeFileSync(join(fixture.root, 'other-storage.test', '.node', 'node.yaml'), 'pre-existing root');
  fixture.observing = false; fixture.operations.length = 0; fixture.write.mockClear();
});
for (const door of ['personal', 'organization', 'app', 'installed'] as const) describe(`database-only root creation: ${door}`, () => {
  it.each(['Ordinary', 'own:legal:multi', 'a::b', 'other-storage.test', 'other-storage.test:notes', 'other-storage.test:notes:deep'])('keeps filesystem byte-identical for legal name %s', async name => {
    const before = snapshot();
    const memory = await create(door, name);
    const organizationId = door === 'personal' ? null : org.id;
    expect(memory).toMatchObject({ name, organizationId });
    expect(memory.urn.startsWith(`${door === 'personal' ? 'storage-person' : org.urn}:`)).toBe(true);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ name, organizationId });
    expect(await db.node.findMany({ where: { memoryId: memory.id } })).toEqual([]); // #3952: no root node on create
    expect(snapshot()).toEqual(before);
    noParticipants();
  });
  it.each(['..:x', '.:x', 'a/b', 'a:', 'a\0b', 'a'.repeat(256)])('preserves invalid-name refusal %j before database writes', async name => {
    const before = snapshot();
    await expect(create(door, name)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
    expect(snapshot()).toEqual(before); noParticipants();
  });
  // #3952: no root node is written, so the database-stage failure is injected at the org-default step, which only
  // the organization door runs. The other doors' rollback is pinned in resolvers.noRootNode3952.test.ts: the agent
  // grant of a knowledge memory in an App, and the group owner row. The personal door and createAppMemory write
  // nothing after the memory row, so they have no step to fail. The skip is visible, not a pass.
  it.runIf(door === 'organization')('rolls back the memory without reading or restoring existing projection bytes', async () => {
    const before = snapshot();
    const fail = vi.spyOn(defaults, 'applyOrgDefaultsAtCreation').mockRejectedValueOnce(new Error('synthetic database-stage failure'));
    try { await expect(create(door, 'other-storage.test:notes')).rejects.toThrow('synthetic database-stage failure'); }
    finally { fail.mockRestore(); }
    expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
    expect(snapshot()).toEqual(before); noParticipants();
  });
});
for (const door of ['organization', 'app', 'installed'] as const) it(`denied ${door} preserves filesystem and database`, async () => {
  const before = snapshot();
  await expect(create(door, 'other-storage.test:notes', true)).rejects.toThrow();
  expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
  expect(snapshot()).toEqual(before); noParticipants();
});

it('observes real snapshot and restore operations even when bytes stay identical', () => {
  const target = join(fixture.root, 'other-storage.test', '.node', 'node.yaml');
  const before = snapshot();
  fixture.observing = true;
  try {
    const bytes = readFileSync(target);
    writeFileSync(target, bytes);
    rmSync(join(fixture.root, 'absent'), { force: true });
  } finally { fixture.observing = false; }
  expect(fixture.operations).toEqual(['readFileSync', 'writeFileSync', 'rmSync']);
  expect(snapshot()).toEqual(before);
});
