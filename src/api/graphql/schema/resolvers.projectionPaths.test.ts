import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { saveNodeToFs } from '../../../integrations/localFs/saveNodeToFs.js';
import { memoryLocalPath } from '../../../integrations/github/gitMirrorCheckout.js';

const projection = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anne-projection-'));
  const root = path.join(base, 'level', 'graphs');
  fs.mkdirSync(root, { recursive: true });
  return { base, root };
});
vi.mock('../../../config.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../config.js')>(), GRAPHS_PATH: projection.root }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
afterAll(() => rmSync(projection.base, { recursive: true, force: true }));
const M = resolvers.Mutation as any;
let org: any, app: any, agent: any, admin: any, plain: any;
const ctx = (id: string): Context => ({ db, userId: id, roles: [] });
beforeEach(async () => {
  await cleanDb(db);
  rmSync(projection.base, { recursive: true, force: true }); mkdirSync(projection.root, { recursive: true });
  org = await db.organization.create({ data: { id: generateId(), name: 'projection', urn: `projection-${generateId().toLowerCase()}` } });
  agent = await db.agent.create({ data: { id: generateId(), name: 'agent', urn: `${org.urn}:agent`, organizationId: org.id } });
  app = (await createDbAppWithKey(db, 'projection-app', org.id)).app;
  await createDbAppAgent(db, app.id, agent.id);
  admin = await db.user.create({ data: { id: generateId(), roles: [] } });
  plain = await db.user.create({ data: { id: generateId(), roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await createDbAppMember(db, app.id, admin.id, 'owner');
});
const create = (door: string, name: string) => door === 'personal'
  ? M.createMemory({}, { name, memoryClass: 'personal' }, ctx(plain.id))
  : door === 'app' ? M.createAppMemory({}, { appRef: app.id, name }, ctx(admin.id))
  : M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name }, ctx(admin.id));
const inputs = ['..:escaped', 'a:..:b', '.:current', 'a:.', '..:..:escaped', String.raw`a\..`, String.raw`..\x`];
for (const door of ['personal', 'app', 'installed']) {
  describe(`projection input ${door}`, () => {
    // #5149: the name is not a path, so a traversal-shaped one is an ordinary name; it must still reach no path.
    it.each(inputs.map((name, i) => [i, name] as const))('creates case %i as a plain name that reaches no path', async (_i, name) => {
      const target = resolve(projection.root, ...name.split(':'));
      const before = readdirSync(projection.base, { recursive: true });
      const memory = await create(door, name);
      expect(memory.name).toBe(name);
      expect(memory.urn.split(':')).toHaveLength(2);
      expect(await db.node.count()).toBe(0);
      expect(existsSync(join(target, '.node'))).toBe(false);
      expect(readdirSync(projection.base, { recursive: true })).toEqual(before);
      // The mirror checkout is placed by the URN, inside the graph root.
      const checkout = memoryLocalPath(memory.urn.split(':')[0]!, memory.urn);
      expect(checkout.startsWith(`${projection.root}${sep}`)).toBe(true);
    });
    // #5203 S3 (cor:urn:010:01): a name with no slug is no longer refused; it creates under the fallback base, and
    // still projects nothing. An empty or blank name is the refusal that replaced it.
    it.each(['..', '.:..', ':'])('creates a name with no slug, %j, under the fallback slug with no projection', async name => {
      const memory = await create(door, name);
      expect(memory.name).toBe(name);
      expect(memory.urn.split(':').pop()).toBe('untitled');
      expect(await db.node.count()).toBe(0);
      expect(readdirSync(projection.root)).toEqual([]);
    });
    it.each(['', '   '])('refuses an empty or blank name, %j, before persistence', async name => {
      await expect(create(door, name)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect(await db.memory.count()).toBe(0);
      expect(readdirSync(projection.root)).toEqual([]);
    });
    it.each(['a..b', 'x.y', 'Has Space', 'ünï', String.raw`back\slash`])('preserves ordinary input %s', async name => {
      const memory = await create(door, name);
      expect(memory.name).toBe(name); // the name is kept as typed; #3952: no root node is created from it
      expect(await db.node.findMany({ where: { memoryId: memory.id } })).toEqual([]);
      expect(existsSync(join(projection.root, ...name.split(':'), '.node', 'node.yaml'))).toBe(false);
    });
  });
}
describe('projection writer boundary', () => {
  it.each(inputs.map((name, i) => [i, name] as const))('refuses invalid direct case %i', async (_i, loc) => {
    const target = resolve(projection.root, ...loc.split(':'));
    const result = await saveNodeToFs({ loc, name: 'synthetic' }, projection.root);
    expect(result.error).toBeDefined();
    expect(existsSync(join(target, '.node'))).toBe(false);
    expect(readdirSync(projection.root)).toEqual([]);
  });
});

it('ordinary creation does not use the standalone projection writer', async () => {
  const made = await create('personal', 'Ordinary root');
  expect(await db.node.count({ where: { memoryId: made.id } })).toBe(0);
  expect(readdirSync(projection.root)).toEqual([]);
});

it.each(['other', 'level/graphs-neighbor'])('refuses an absolute direct destination (%s)', async sibling => {
  const target = join(projection.base, sibling);
  const result = await saveNodeToFs({ loc: target, name: 'synthetic' }, projection.root);
  expect(result.error).toBeDefined();
  expect(existsSync(join(target, '.node'))).toBe(false);
});
