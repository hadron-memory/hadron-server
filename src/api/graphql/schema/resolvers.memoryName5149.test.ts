/**
 * #5149 — a memory's display name has no grammar (cor:dmo:060:01); only the slug derived from it does (cor:urn:010:01/:02).
 * The #2730 refusals existed for the root node the name used to become, which #3952 (R11) removed. What still refuses is
 * a name that cannot be stored, or that yields no slug, and both refuse before any write.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { isValidSlug } from '../../../lib/urn.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

let graphsPath: string;
vi.mock('../../../config.js', async (original) => ({
  ...await original<typeof import('../../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
beforeAll(() => { graphsPath = mkdtempSync(join(process.env.GRAPHS_PATH!, 'memname5149-')); });
beforeEach(() => { rmSync(graphsPath, { recursive: true, force: true }); mkdirSync(graphsPath); });
afterAll(() => rmSync(graphsPath, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const M = resolvers.Mutation as any;
let org: any, app: any, agent: any, admin: any, outsider: any;
const ctx = (userId: string): Context => ({ db, userId, roles: [] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org', urn: 'memname5149.test' } });
  agent = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${org.urn}:coach`, organizationId: org.id } });
  app = (await createDbAppWithKey(db, 'coach-app', org.id)).app;
  await createDbAppAgent(db, app.id, agent.id);
  admin = await db.user.create({ data: { githubId: 514901, githubUsername: 'admin5149' } });
  outsider = await db.user.create({ data: { githubId: 514902, githubUsername: 'outsider5149' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await createDbAppMember(db, app.id, admin.id, 'owner');
});

type Create = (name: string, who?: string) => Promise<any>;
const doors: [string, Create][] = [
  ['createMemory', (name, who = admin.id) => M.createMemory({}, { orgRef: org.id, name }, ctx(who))],
  ['createAppMemory', (name, who = admin.id) => M.createAppMemory({}, { appRef: app.id, name }, ctx(who))],
  ['createMemoryInApp app', (name, who = admin.id) => M.createMemoryInApp(
    {}, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name }, ctx(who))],
  ['createMemoryInApp personal', (name, who = admin.id) => M.createMemoryInApp(
    {}, { appRef: app.id, agentRef: agent.id, memoryClass: 'personal', name }, ctx(who))],
];

/** Every name #2730 refused that can be stored and yields a slug, with the slug it yields. */
const admitted: [string, string, string][] = [
  ['a trailing colon', 'abc:', 'abc'],
  ['a slash', 'a/b', 'a-b'],
  ['a 256-byte segment', 'x'.repeat(256), 'x'.repeat(64)],
  ['a 300-character segment', 'x'.repeat(300), 'x'.repeat(64)],
  ['a multibyte segment over 255 bytes', `a${'é'.repeat(128)}`, 'a'],
  ['a long segment after a legal one', `ok:${'y'.repeat(256)}`, `ok-${'y'.repeat(61)}`],
  ['a parent-directory segment', 'a:..:b', 'a-..-b'],
  ['a leading parent directory', '../x', 'x'],
  ['a Windows parent directory', '..\\x', 'x'],
  ['a dot segment', '.:x', 'x'],
];
/** Names that yield no slug, and names that cannot be stored. */
const refused: [string, string][] = [
  ['only a colon', ':'],
  ['a parent directory', '..'],
  ['a dot', '.'],
  ['only slashes', '///'],
  ['only characters outside the slug alphabet', 'é'.repeat(128)],
  ['only punctuation', '!!!'],
  ['a NUL', 'a\0b'],
  ['an unpaired surrogate', 'a\uD800b'],
];

for (const [door, create] of doors) {
  describe(`#5149 ${door}`, () => {
    for (const [label, name, slug] of admitted) {
      it(`creates a memory named with ${label}, keeping the name, with a valid slug and no node or file`, async () => {
        const { id } = await create(name);
        const row = await db.memory.findUniqueOrThrow({ where: { id } });
        expect(row.name).toBe(name);
        const [root, stored, ...rest] = row.urn.split(':');
        expect([root, rest]).toEqual([org.urn, []]);
        // A personal memory's slug is an opaque id; every other door's is the one derived from the name.
        if (door !== 'createMemoryInApp personal') {
          expect(stored).toBe(slug);
          expect(isValidSlug(stored!)).toBe(true);
        }
        expect(await db.node.count({ where: { memoryId: id } })).toBe(0);
        expect(readdirSync(graphsPath, { recursive: true })).toEqual([]);
      });
    }
    for (const [label, name] of refused) {
      it(`refuses ${label}, typed in the resolver, with nothing written`, async () => {
        await expect(create(name)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
        expect(await db.memory.count()).toBe(0);
      });
      it(`answers the authorization refusal before the refusal of ${label}`, async () => {
        const code = await create(name, outsider.id).then(() => 'CREATED', e => e.extensions?.code);
        expect(code).toBeDefined();
        expect(['CREATED', 'BAD_USER_INPUT']).not.toContain(code);
      });
    }
  });
}

describe('#5149 createMemory in the caller\'s own namespace', () => {
  for (const [label, name] of refused) {
    it(`refuses ${label} before the caller's root name is claimed`, async () => {
      // ensureUserHandle claims a pool principal for a user who has none yet: the first write of this door.
      expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).principalId).toBeNull();
      await expect(M.createMemory({}, { name, memoryClass: 'private' }, ctx(admin.id)))
        .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).principalId).toBeNull();
    });
  }
  it('creates a memory whose name ends in a colon under the caller\'s handle', async () => {
    const { id } = await M.createMemory({}, { name: 'Notes:', memoryClass: 'private' }, ctx(admin.id));
    const { handle } = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await db.memory.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: 'Notes:', urn: `${handle}:notes` });
  });
});

describe('#5149 a name admitted now still collides on its slug', () => {
  it('createMemory refuses "abc:" where "abc" exists', async () => {
    await doors[0]![1]('abc');
    await expect(doors[0]![1]('abc:')).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
  });
});

describe('#5149 MCP delegates', () => {
  const tools: [string, () => Record<string, unknown>][] = [
    ['hadron_create_memory', () => ({ org: org.id })],
    ['hadron_create_app_memory', () => ({ app: app.id })],
  ];
  const mcp = () => createTestableMcpServer({ userId: admin.id, roles: [] as any[], clientId: `user:${admin.id}` });
  for (const [tool, args] of tools) {
    it(`${tool} creates a memory whose name ends in a colon`, async () => {
      await mcp().callToolText(tool, { ...args(), name: 'abc:' });
      expect(await db.memory.findMany({ select: { name: true, urn: true } })).toEqual([{ name: 'abc:', urn: `${org.urn}:abc` }]);
    });
    for (const [label, name] of refused) {
      it(`${tool} refuses ${label} as caller input, never a fault`, async () => {
        const text = await mcp().callToolText(tool, { ...args(), name });
        expect(text).toMatch(/name/i);
        expect(text).not.toMatch(/internal|request id/i);
        expect(await db.memory.count()).toBe(0);
      });
    }
  }
});
