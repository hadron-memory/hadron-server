/**
 * #2476 — the `chats` (startChat) and `revisions` (createRevision) parent
 * ensures wrap an `update: {}` upsert whose cold-path race loses with P2002
 * (hrn:node:hadronmemory.com:dev:findings:prisma-upsert-not-race-safe). Only
 * that loss means "the parent exists": a P2002 on the node `(loc, memory_id)`
 * unique is swallowed, and every other failure (another unique, a foreign key,
 * a dropped connection) propagates instead of being read as success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { isNodeLocUniqueViolation } from '../../../lib/prismaErrors.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };
let agentId: string;
let systemMemoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-2476', urn: 'org-2476' } });
  admin = await db.user.create({ data: { githubId: 24760, githubUsername: 'admin-2476', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await resolvers.Mutation.createAgent(
    {}, { orgId: org.id, name: 'agent-2476', visibility: 'PERSONAL' },
    { db, roles: ['ADMIN'], userId: admin.id },
  );
  agentId = created.id;
  systemMemoryId = created.systemMemoryId!;
  for (const n of [
    { loc: 'conversations' },
    { loc: 'conversations:hello', data: { stageOrder: ['greet'], isSetup: false } },
    { loc: 'conversations:hello:greet', data: { promptRef: 'prompts:hello:greet' } },
    { loc: 'prompts' },
    { loc: 'prompts:hello' },
    { loc: 'prompts:hello:greet', content: 'Hello world!' },
  ] as Array<{ loc: string; data?: unknown; content?: string }>) {
    await db.node.create({
      data: {
        id: generateId(), memoryId: systemMemoryId, loc: n.loc,
        name: n.loc.split(':').pop()!, nodeType: 'system',
        data: (n.data ?? null) as never, content: n.content ?? null,
      },
    });
  }
});

function known(code: string, target?: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`stub ${code}`, {
    code, clientVersion: Prisma.prismaVersion.client,
    meta: target === undefined ? undefined : { target },
  });
}

/** `db` with `node.upsert` throwing `err` for the parent at `loc`; everything else is the real client. */
function dbFailingParentUpsert(loc: string, err: Error): Context['db'] {
  const node = new Proxy(db.node, {
    get(target, prop, receiver) {
      if (prop === 'upsert') {
        return (args: { where?: { loc_memoryId?: { loc?: string } } }) => {
          if (args?.where?.loc_memoryId?.loc === loc) return Promise.reject(err);
          return target.upsert(args as never);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'node') return node;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Context['db'];
}

async function seedParent(loc: string) {
  await db.node.create({
    data: { id: generateId(), memoryId: systemMemoryId, loc, name: loc, nodeType: 'system' },
  });
}

const sites = [
  {
    name: 'startChat (chats parent)',
    parentLoc: 'chats',
    run: (ctxDb: Context['db']) =>
      resolvers.Mutation.startChat({}, { agentId }, { db: ctxDb, roles: ['ADMIN'], userId: admin.id }),
  },
  {
    name: 'createRevision (revisions parent)',
    parentLoc: 'revisions',
    run: (ctxDb: Context['db']) =>
      resolvers.Mutation.createRevision({}, { agentId }, { db: ctxDb, roles: ['ADMIN'], userId: admin.id }),
  },
] as const;

describe('#2476 parent-node ensure: only the (loc, memory_id) race is swallowed', () => {
  for (const site of sites) {
    describe(site.name, () => {
      it('swallows a P2002 on the node (loc, memory_id) unique (the race loser; the parent exists)', async () => {
        await seedParent(site.parentLoc);
        await expect(site.run(dbFailingParentUpsert(site.parentLoc, known('P2002', ['loc', 'memory_id']))))
          .resolves.toBeTruthy();
      });

      it('rethrows a P2002 on a different unique', async () => {
        await seedParent(site.parentLoc);
        const err = known('P2002', ['urn']);
        await expect(site.run(dbFailingParentUpsert(site.parentLoc, err))).rejects.toBe(err);
      });

      it('rethrows a P2002 that names no target', async () => {
        await seedParent(site.parentLoc);
        const err = known('P2002');
        await expect(site.run(dbFailingParentUpsert(site.parentLoc, err))).rejects.toBe(err);
      });

      it('rethrows a P2003 (foreign key)', async () => {
        await seedParent(site.parentLoc);
        const err = known('P2003', 'nodes_memory_id_fkey');
        await expect(site.run(dbFailingParentUpsert(site.parentLoc, err))).rejects.toBe(err);
      });

      it('rethrows a plain error (connection loss)', async () => {
        await seedParent(site.parentLoc);
        const err = new Error('Connection terminated unexpectedly');
        await expect(site.run(dbFailingParentUpsert(site.parentLoc, err))).rejects.toBe(err);
      });
    });
  }
});

describe('isNodeLocUniqueViolation', () => {
  it('matches what the engine reports for a real (loc, memory_id) collision', async () => {
    await seedParent('dup');
    const err = await db.node
      .create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'dup', name: 'dup', nodeType: 'system' } })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(isNodeLocUniqueViolation(err)).toBe(true);
  });

  it('accepts either column spelling and the constraint name', () => {
    expect(isNodeLocUniqueViolation(known('P2002', ['loc', 'memory_id']))).toBe(true);
    expect(isNodeLocUniqueViolation(known('P2002', ['memoryId', 'loc']))).toBe(true);
    expect(isNodeLocUniqueViolation(known('P2002', 'nodes_loc_memory_id_key'))).toBe(true);
  });

  it('refuses a partial or foreign target', () => {
    expect(isNodeLocUniqueViolation(known('P2002', ['loc']))).toBe(false);
    expect(isNodeLocUniqueViolation(known('P2002', ['memory_id']))).toBe(false);
    expect(isNodeLocUniqueViolation(known('P2002', ['loc', 'memory_id', 'urn']))).toBe(false);
    expect(isNodeLocUniqueViolation(known('P2002', 'edges_loc_memory_id_key'))).toBe(false);
    expect(isNodeLocUniqueViolation(known('P2003', ['loc', 'memory_id']))).toBe(false);
    expect(isNodeLocUniqueViolation(Object.assign(new Error('x'), { code: 'P2002', meta: { target: ['loc', 'memory_id'] } }))).toBe(false);
    expect(isNodeLocUniqueViolation(null)).toBe(false);
  });
});
