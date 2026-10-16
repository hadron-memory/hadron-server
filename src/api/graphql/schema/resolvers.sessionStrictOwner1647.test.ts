/**
 * #1647 (cor:acl:010:02, strict owner wins) — a platform admin's session write override stops at a session bound to
 * ANOTHER user's personal/private memory: updateSession, endSession and POST /sessions/:id/outcome all refuse, with no
 * side effects. The admin's own sessions and sessions bound to shared memories keep the override.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { signJwt } from '../../../auth/jwt.js';
import { createServer } from '../../../server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const ctx = (over: Partial<Context> = {}): Context => ({ db, roles: ['READER'], ...over });

let server: Server;
let baseUrl: string;
let owner: { id: string };
let admin: { id: string };
let adminJwt: string;
let ownerJwt: string;
let personalSession: string;
let privateSession: string;
let sharedSession: string;
let adminOwnSession: string;

async function mkMemory(cls: 'personal' | 'private' | 'knowledge', userId: string | null, tag: string) {
  return db.memory.create({
    data: { id: generateId(), ownerUserId: owner.id, name: tag, urn: `t1647-${tag}-${generateId()}`, class: cls, userId },
  });
}

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  owner = await db.user.create({ data: { id: generateId(), handle: `o1647-${sfx}`, githubUsername: `o1647-${sfx}`, roles: ['CONTRIBUTOR'] } });
  admin = await db.user.create({ data: { id: generateId(), handle: `a1647-${sfx}`, githubUsername: `a1647-${sfx}`, roles: ['ADMIN'] } });
  adminJwt = await signJwt({ sub: admin.id, roles: ['ADMIN'] });
  ownerJwt = await signJwt({ sub: owner.id, roles: ['CONTRIBUTOR'] });
  const personal = await mkMemory('personal', owner.id, 'personal');
  const priv = await mkMemory('private', owner.id, 'private');
  const shared = await mkMemory('knowledge', null, 'shared');
  const mk = (userId: string, memoryId: string | null) =>
    db.session.create({ data: { id: generateId(), type: 'DEVELOPER', userId, memoryId } }).then((s) => s.id);
  personalSession = await mk(owner.id, personal.id);
  privateSession = await mk(owner.id, priv.id);
  sharedSession = await mk(owner.id, shared.id);
  adminOwnSession = await mk(admin.id, personal.id);
});

const outcome = (id: string, token: string) =>
  fetch(`${baseUrl}/sessions/${id}/outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ outcome: 0.5 }),
  }).then((r) => r.status);

describe('requireSessionWriteAccess, strict owner (#1647)', () => {
  for (const [label, get] of [['personal', () => personalSession], ['private', () => privateSession]] as const) {
    it(`refuses a platform admin updating a session bound to another user's ${label} memory`, async () => {
      await expect(
        M.updateSession({}, { id: get(), branch: 'x' }, ctx({ userId: admin.id, roles: ['ADMIN'] })),
      ).rejects.toThrow();
      expect((await db.session.findUniqueOrThrow({ where: { id: get() } })).branch).toBeNull();
    });
    it(`refuses a platform admin ending a session bound to another user's ${label} memory`, async () => {
      await expect(
        M.endSession({}, { id: get(), summary: 'x' }, ctx({ userId: admin.id, roles: ['ADMIN'] })),
      ).rejects.toThrow();
      expect((await db.session.findUniqueOrThrow({ where: { id: get() } })).endedAt).toBeNull();
    });
  }

  it('keeps the admin override for a session bound to a shared memory', async () => {
    await M.updateSession({}, { id: sharedSession, branch: 'x' }, ctx({ userId: admin.id, roles: ['ADMIN'] }));
    expect((await db.session.findUniqueOrThrow({ where: { id: sharedSession } })).branch).toBe('x');
  });

  it('lets the strict owner and the admin on their own session through', async () => {
    await M.updateSession({}, { id: personalSession, branch: 'o' }, ctx({ userId: owner.id }));
    await M.updateSession({}, { id: adminOwnSession, branch: 'a' }, ctx({ userId: admin.id, roles: ['ADMIN'] }));
  });
});

describe('POST /sessions/:id/outcome, strict owner (#1647)', () => {
  it('refuses a platform admin on a foreign personal-bound session with no side effects', async () => {
    const before = await db.session.findUniqueOrThrow({ where: { id: personalSession } });
    expect(await outcome(personalSession, adminJwt)).toBe(404);
    const after = await db.session.findUniqueOrThrow({ where: { id: personalSession } });
    expect(after.outcome).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
  it('refuses a platform admin on a private-bound session too', async () => {
    expect(await outcome(privateSession, adminJwt)).toBe(404);
  });
  it('still records an outcome for the owner and for a shared-memory session', async () => {
    expect(await outcome(personalSession, ownerJwt)).toBe(200);
    expect(await outcome(sharedSession, adminJwt)).toBe(200);
  });
});
