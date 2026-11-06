import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import * as locks from '../../../lib/nodeSubtreeLock.js';
import { memoryLocalPath } from '../../../integrations/github/gitMirrorCheckout.js';

const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'root-storage-')),
    snapshot: vi.fn(), cleanup: vi.fn(), write: vi.fn() };
});
vi.mock('../../../config.js', async original => ({ ...await original<typeof import('../../../config.js')>(), GRAPHS_PATH: fixture.root }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// Observe the old participants without replacing their real behavior: before retirement
// these wrappers still perform the real snapshot/write against our private fixture.
vi.mock('../../../lib/fsProjectionRollback.js', async original => {
  const actual = await original<Record<string, (...args: any[]) => any>>();
  return { ...actual,
    snapshotProjection: (...args: any[]) => { fixture.snapshot(); return actual.snapshotProjection?.(...args); },
    projectionCleanupFor: (...args: any[]) => { fixture.cleanup(); return actual.projectionCleanupFor?.(...args); },
  };
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
function create(door: Door, name: string, denied = false) {
  const ctx = context(denied || door === 'personal' ? plain.id : admin.id);
  if (door === 'personal') return M.createMemory({}, { name, memoryClass: 'personal' }, ctx);
  if (door === 'organization') return M.createMemory({}, { name, orgId: org.id }, ctx);
  if (door === 'app') return M.createAppMemory({}, { name, appRef: app.id }, ctx);
  return M.createMemoryInApp({}, { name, appRef: app.id, agentRef: agent.id, memoryClass: 'app' }, ctx);
}
function snapshot(dir = fixture.root): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name), rel = relative(fixture.root, path);
    return entry.isDirectory() ? [`directory:${rel}`, ...snapshot(path)]
      : [`file:${rel}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`];
  });
}
function noParticipants() {
  expect(fixture.snapshot).not.toHaveBeenCalled();
  expect(fixture.cleanup).not.toHaveBeenCalled();
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
  fixture.snapshot.mockClear(); fixture.cleanup.mockClear(); fixture.write.mockClear();
});
for (const door of ['personal', 'organization', 'app', 'installed'] as const) describe(`database-only root creation: ${door}`, () => {
  it.each(['Ordinary', 'own:legal:multi', 'a::b', 'other-storage.test', 'other-storage.test:notes', 'other-storage.test:notes:deep'])('keeps filesystem byte-identical for legal name %s', async name => {
    const before = snapshot();
    const memory = await create(door, name);
    expect(memory).toMatchObject({ name });
    expect(memory.urn.startsWith(`${door === 'personal' ? 'storage-person' : org.urn}:`)).toBe(true);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ name });
    expect(await db.node.findMany({ where: { memoryId: memory.id } })).toMatchObject([{ loc: name, name: name.split(':').at(-1), description: 'Root node for this memory.' }]);
    expect(snapshot()).toEqual(before);
    noParticipants();
  });
  it.each(['..:x', '.:x', 'a/b', 'a:', 'a\0b', 'a'.repeat(256)])('preserves invalid-name refusal %j before database writes', async name => {
    const before = snapshot();
    await expect(create(door, name)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
    expect(snapshot()).toEqual(before); noParticipants();
  });
  it('rolls back both database rows without reading or restoring existing projection bytes', async () => {
    const before = snapshot();
    const fail = vi.spyOn(locks, 'lockLocForWrite').mockRejectedValueOnce(new Error('synthetic database-stage failure'));
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
