import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import * as rootHelpers from './resolvers.helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { saveNodeToFs } from '../../../integrations/localFs/saveNodeToFs.js';

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
    it.each(inputs.map((name, i) => [i, name] as const))('refuses invalid case %i before persistence', async (_i, name) => {
      const target = resolve(projection.root, ...name.split(':'));
      expect(existsSync(join(target, '.node'))).toBe(false);
      await expect(create(door, name)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect(await db.memory.count()).toBe(0);
      expect(await db.node.count()).toBe(0);
      expect(existsSync(join(target, '.node'))).toBe(false);
      expect(readdirSync(projection.root)).toEqual([]);
    });
    it.each(['a..b', 'x.y', 'Has Space', 'ünï', String.raw`back\slash`])('preserves ordinary input %s', async name => {
      const memory = await create(door, name);
      expect(await db.node.findMany({ where: { memoryId: memory.id } })).toMatchObject([{ loc: name }]);
      expect(existsSync(join(projection.root, ...name.split(':'), '.node', 'node.yaml'))).toBe(true);
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

it('writer refusal alone preserves the documented persistence limit', async () => {
  // This suppresses only input validation to isolate the filesystem fence; authorization gates remain live.
  const input = vi.spyOn(rootHelpers, 'assertMemoryRootLoc').mockImplementation(() => undefined);
  try {
    await expect(create('personal', '..:residue')).rejects.toThrow();
    expect(existsSync(resolve(projection.root, '..', 'residue'))).toBe(false);
    // Transactional cleanup belongs to the separately tracked root-write rollback work.
    expect(await db.memory.count()).toBe(1);
  } finally { input.mockRestore(); }
});

it.each(['other', 'level/graphs-neighbor'])('refuses an absolute direct destination (%s)', async sibling => {
  const target = join(projection.base, sibling);
  const result = await saveNodeToFs({ loc: target, name: 'synthetic' }, projection.root);
  expect(result.error).toBeDefined();
  expect(existsSync(join(target, '.node'))).toBe(false);
});
