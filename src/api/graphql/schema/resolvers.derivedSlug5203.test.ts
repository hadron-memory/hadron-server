/**
 * #5203 S3 — a slug DERIVED from a name never refuses the entity's creation; it iterates instead
 * (hrn:node:hadronmemory.com:specs:cor:urn:010:01, Durable). Gate: CHECKED T1 on #5203 as amended by Bridget's answers
 * (issuecomment-7176838481), with the specs engineer's reading (issuecomment-7166937717):
 *
 * - a reserved word is never stored: `Agent` and `Agent:` create under a slug that passes `isValidSlug`, the name kept;
 * - a second name that collapses to a taken slug creates under another slug;
 * - a name that yields no slug (`!!!`, `:`, only non-ASCII letters) creates under a fallback base;
 * - `''` and a whitespace-only name are refused BAD_USER_INPUT because the NAME is invalid, before deriving;
 * - a deleted holder of the derived slug is left in place and the new entity takes another slug (never reclaimed).
 *
 * A slug the caller SUPPLIES is not derived and keeps today's answers (resolvers.slugArg5203.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { isValidSlug, parseUrn } from '../../../lib/urn.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

let graphsPath: string;
vi.mock('../../../config.js', async (original) => ({
  ...await original<typeof import('../../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
beforeAll(() => { graphsPath = mkdtempSync(join(process.env.GRAPHS_PATH!, 'derivedslug5203-')); });
beforeEach(() => { rmSync(graphsPath, { recursive: true, force: true }); mkdirSync(graphsPath); });
afterAll(() => rmSync(graphsPath, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const M = resolvers.Mutation as any;
let org: any, admin: any, app: any, installed: any, source: any;
const ctx = (userId: string): Context => ({ db, userId, roles: [] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org', urn: 'derivedslug5203.test' } });
  admin = await db.user.create({ data: { githubId: 520331, githubUsername: 'admin5203s3' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  installed = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${org.urn}:coach`, organizationId: org.id } });
  app = (await createDbAppWithKey(db, 'coach-app', org.id)).app;
  await createDbAppAgent(db, app.id, installed.id);
  await createDbAppMember(db, app.id, admin.id, 'owner');
  // A clonable source and an installable agent: an ordinary agent of this org, made through the door.
  source = await M.createAgent({}, { orgRef: org.id, name: 'Clone Source' }, ctx(admin.id));
});

type Kind = 'memory' | 'agent' | 'app';
type Door = { door: string; kind: Kind; create: (name: string) => Promise<{ id: string }> };
const doors: Door[] = [
  { door: 'createMemory', kind: 'memory', create: (name) => M.createMemory({}, { orgRef: org.id, name }, ctx(admin.id)) },
  { door: 'createAppMemory', kind: 'memory', create: (name) => M.createAppMemory({}, { appRef: app.id, name }, ctx(admin.id)) },
  { door: 'createMemoryInApp app', kind: 'memory', create: (name) => M.createMemoryInApp(
    {}, { appRef: app.id, agentRef: installed.id, memoryClass: 'app', name }, ctx(admin.id)) },
  { door: 'createAgent', kind: 'agent', create: (name) => M.createAgent({}, { orgRef: org.id, name }, ctx(admin.id)) },
  { door: 'cloneAgent', kind: 'agent', create: (name) => M.cloneAgent({}, { source: source.id, target: org.id, name }, ctx(admin.id)) },
  { door: 'createApp', kind: 'app', create: (name) => M.createApp({}, { orgRef: org.id, agentRef: source.id, name }, ctx(admin.id)) },
];

const TYPE: Record<Kind, string> = { memory: 'mem', agent: 'agent', app: 'app' };
async function rowOf(kind: Kind, id: string): Promise<{ urn: string; name: string }> {
  if (kind === 'memory') return db.memory.findUniqueOrThrow({ where: { id }, select: { urn: true, name: true } });
  if (kind === 'agent') return db.agent.findUniqueOrThrow({ where: { id }, select: { urn: true, name: true } });
  return db.app.findUniqueOrThrow({ where: { id }, select: { urn: true, name: true } });
}
async function count(kind: Kind): Promise<number> {
  if (kind === 'memory') return db.memory.count();
  if (kind === 'agent') return db.agent.count();
  return db.app.count();
}
/** Through the door's own delete, so whatever it tombstones with the row (an Agent's system memory) goes too. */
async function softDelete(kind: Kind, id: string): Promise<void> {
  const del = kind === 'memory' ? M.deleteMemory : kind === 'agent' ? M.deleteAgent : M.deleteApp;
  expect(await del({}, { ref: id }, ctx(admin.id))).toBe(true);
  if (kind === 'memory') expect((await db.memory.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  else if (kind === 'agent') expect((await db.agent.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  else expect((await db.app.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
}
/** The stored slug of a fresh row, after asserting it is a single valid atom under the org and that its URN parses back. */
async function slugOf(kind: Kind, id: string, name: string): Promise<string> {
  const row = await rowOf(kind, id);
  expect(row.name).toBe(name);
  const [root, slug, ...rest] = row.urn.split(':');
  expect([root, rest]).toEqual([org.urn, []]);
  expect(isValidSlug(slug!)).toBe(true);
  expect(parseUrn(`hrn:${TYPE[kind]}:${row.urn}`)).toBeTruthy();
  return slug!;
}

for (const { door, kind, create } of doors) {
  describe(`#5203 S3 ${door}: a derived slug iterates`, () => {
    it('a reserved word is never stored: "Agent" and "Agent:" both create, with valid, distinct slugs', async () => {
      const a = await slugOf(kind, (await create('Agent')).id, 'Agent');
      const b = await slugOf(kind, (await create('Agent:')).id, 'Agent:');
      expect(a).not.toBe(b);
    });

    it('every case of a reserved word iterates (matched case-insensitively)', async () => {
      for (const name of ['memory', 'MEMORY', 'Task']) {
        await slugOf(kind, (await create(name)).id, name);
      }
    });

    it('a second name that collapses to a taken slug creates under another slug', async () => {
      const first = await slugOf(kind, (await create('Notes')).id, 'Notes');
      const second = await slugOf(kind, (await create('notes:')).id, 'notes:');
      expect(first).toBe('notes');
      expect(second).not.toBe('notes');
    });

    it('a name that yields no slug creates under a fallback base, which iterates in turn', async () => {
      const slugs: string[] = [];
      for (const name of ['!!!', ':', 'éééé']) slugs.push(await slugOf(kind, (await create(name)).id, name));
      expect(new Set(slugs).size).toBe(3);
    });

    // cloneAgent's name is optional: an empty or blank one means "keep the source's name" (writeClone), not an
    // invalid name, so it creates under that name's derived slug.
    if (door === 'cloneAgent') {
      it('an empty or whitespace-only name keeps the source\'s name, under a valid slug that iterates', async () => {
        const slugs = [];
        for (const name of ['', '   ']) {
          const { id } = await create(name);
          slugs.push(await slugOf(kind, id, 'Clone Source'));
        }
        expect(new Set(slugs).size).toBe(2);
      });
    } else {
      it('an empty or whitespace-only name is refused BAD_USER_INPUT before deriving, and creates nothing', async () => {
        const before = await count(kind);
        for (const name of ['', '   ']) {
          await expect(create(name)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
        }
        expect(await count(kind)).toBe(before);
      });
    }

    it('a deleted holder of the derived slug stays in place, and the new row takes another slug', async () => {
      const old = await create('Kept');
      expect(await slugOf(kind, old.id, 'Kept')).toBe('kept');
      await softDelete(kind, old.id);
      const fresh = await slugOf(kind, (await create('Kept')).id, 'Kept');
      expect(fresh).not.toBe('kept');
      expect((await rowOf(kind, old.id)).urn).toBe(`${org.urn}:kept`);
    });
  });
}

describe('#5203 S3 a SUPPLIED slug keeps today\'s answers on a deleted holder', () => {
  it('createMemory reclaims a deleted holder of the exact supplied slug', async () => {
    const old = await M.createMemory({}, { orgRef: org.id, name: 'Kept' }, ctx(admin.id));
    await softDelete('memory', old.id);
    const made = await M.createMemory({}, { orgRef: org.id, name: 'Other', slug: 'kept' }, ctx(admin.id));
    expect((await rowOf('memory', made.id)).urn).toBe(`${org.urn}:kept`);
    expect(await db.memory.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('createAgent reclaims a deleted holder of the exact supplied slug', async () => {
    const old = await M.createAgent({}, { orgRef: org.id, name: 'Kept' }, ctx(admin.id));
    await softDelete('agent', old.id);
    const made = await M.createAgent({}, { orgRef: org.id, name: 'Other', slug: 'kept' }, ctx(admin.id));
    expect((await rowOf('agent', made.id)).urn).toBe(`${org.urn}:kept`);
    expect(await db.agent.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('createApp with a supplied urn still answers CONFLICT on a live holder', async () => {
    await M.createApp({}, { orgRef: org.id, agentRef: source.id, name: 'One', urn: 'taken' }, ctx(admin.id));
    await expect(M.createApp({}, { orgRef: org.id, agentRef: source.id, name: 'Two', urn: 'taken' }, ctx(admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
  });
});
