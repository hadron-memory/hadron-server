/**
 * #5203 S1 — an optional `slug` on `createMemory` and `createAgent`. A slug the caller supplies is not derived: it is
 * validated and refused when reserved or taken, with the answers those doors already give (`CONFLICT`,
 * `AGENT_URN_TAKEN`), so a client's field error keeps matching (hrn:node:hadronmemory.com:specs:cor:urn:010:01).
 * Omitted, the door derives from the name exactly as before.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

let graphsPath: string;
vi.mock('../../../config.js', async (original) => ({
  ...await original<typeof import('../../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
beforeAll(() => { graphsPath = mkdtempSync(join(process.env.GRAPHS_PATH!, 'slugarg5203-')); });
beforeEach(() => { rmSync(graphsPath, { recursive: true, force: true }); mkdirSync(graphsPath); });
afterAll(() => rmSync(graphsPath, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const M = resolvers.Mutation as any;
let org: any, admin: any;
const ctx = (userId: string): Context => ({ db, userId, roles: [] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org', urn: 'slugarg5203.test' } });
  admin = await db.user.create({ data: { githubId: 520301, githubUsername: 'admin5203' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

type Create = (args: { name: string; slug?: string | null }) => Promise<{ id: string }>;
const doors: [string, Create, (id: string) => Promise<string>, string][] = [
  ['createMemory', (a) => M.createMemory({}, { orgRef: org.id, ...a }, ctx(admin.id)),
    async (id) => (await db.memory.findUniqueOrThrow({ where: { id } })).urn, 'CONFLICT'],
  ['createAgent', (a) => M.createAgent({}, { orgRef: org.id, ...a }, ctx(admin.id)),
    async (id) => (await db.agent.findUniqueOrThrow({ where: { id } })).urn, 'AGENT_URN_TAKEN'],
];

for (const [door, create, urnOf, takenCode] of doors) {
  describe(`#5203 S1 ${door} slug argument`, () => {
    it('stores the supplied slug, keeps the display name, and derives nothing from the name', async () => {
      const made = await create({ name: 'Some Display Name', slug: 'chosen-slug' });
      expect(await urnOf(made.id)).toBe(`${org.urn}:chosen-slug`);
    });

    it('omitted or null, the slug is still derived from the name', async () => {
      expect(await urnOf((await create({ name: 'Derived One' })).id)).toBe(`${org.urn}:derived-one`);
      expect(await urnOf((await create({ name: 'Derived Two', slug: null })).id)).toBe(`${org.urn}:derived-two`);
    });

    it('a taken supplied slug is refused with the door\'s own answer, and creates nothing', async () => {
      await create({ name: 'first', slug: 'dup' });
      await expect(create({ name: 'second', slug: 'dup' })).rejects.toMatchObject({ extensions: { code: takenCode } });
    });

    it('a reserved word is refused BAD_USER_INPUT, case-insensitively, and creates nothing', async () => {
      for (const slug of ['agent', 'Agent']) {
        await expect(create({ name: 'x', slug })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      }
    });

    it('a malformed slug (empty, uppercase, spaces, colon) is refused BAD_USER_INPUT', async () => {
      for (const slug of ['', 'Has Space', 'a:b', 'UPPER']) {
        await expect(create({ name: 'x', slug }), JSON.stringify(slug)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      }
    });
  });
}
