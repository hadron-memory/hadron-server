/**
 * #5398 (hrn:node:hadronmemory.com:specs:cor:api:120:03, App-key line, Decided 2026-11-27 "Add an own-memory read"): a pure
 * App key (no user, no session, no impersonation, not a run) READS its own App's shared `app`-class memories (`app_id` = the
 * key's App, `userMemoryOfAgentId` null, no Worker on it) and so lists them, on every surface, through one predicate
 * (`src/lib/appOwnMemory.ts`). Any key of the App, no scope (Holger, "Any key of the App"); per-user anonymous rows out
 * (Holger, "Out"); read only; encrypted memories unchanged.
 *
 * What is red on main (20d6b9ad):
 *  - a USER-owned App's own app memory: every surface refuses, because `admissibleFoldRows` rule 2 drops a user-owned row for
 *    a credential-only principal and the MCP gate's `ownerUserId` branch has no own-App arm;
 *  - an ORG-owned App's own app memory: the reads already admit it (the team-space fold), but GraphQL `memories` has no
 *    own-App arm, so the list leaves it out (list != reads).
 * Every control below is green on main and must stay green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds, getMemoryAccess } from '../../../mcp/access-control.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { ownAppMemoryIds } from '../../../lib/appOwnMemory.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const LOC = 'doc';
const TOKEN = 'own5398needle';

type Mem = { id: string; urn: string; name: string };
type AppRow = { id: string; ownerUserId: string | null; organizationId: string | null };

let org: { id: string; urn: string };
let otto: { id: string; handle: string };
let stranger: { id: string };
let orgApp: AppRow;
let userApp: AppRow;
let otherApp: AppRow;
let agentId: string;

const keyAuth = (appId: string, extra: Partial<AuthContext> = {}): AuthContext =>
  ({ appId, roles: [], clientId: `app:${appId}`, ...extra } as AuthContext);
const ctxOf = (auth: AuthContext): Context => ({ db, ...auth } as unknown as Context);
const nodeUrn = (m: Mem, loc = LOC) => `hrn:node:${m.urn}:${loc}`;

async function appMemory(app: AppRow, name: string, extra: Record<string, unknown> = {}): Promise<Mem> {
  const prefix = app.organizationId ? org.urn : otto.handle;
  const mem = await db.memory.create({
    data: {
      id: generateId(), name, urn: `${prefix}:${name}`, class: 'app', appId: app.id, visibility: null,
      organizationId: app.organizationId, ownerUserId: app.ownerUserId, ...extra,
    } as never,
  });
  await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: LOC, name: `${TOKEN} ${name}`, content: `secret ${name}` } });
  return mem as Mem;
}

const listIds = async (auth: AuthContext) =>
  ((await Q.memories(null, { limit: 100 }, ctxOf(auth))).items as { id: string }[]).map((m) => m.id).sort();
const recordRead = async (auth: AuthContext, ref: string) =>
  Q.memory(null, { ref }, ctxOf(auth)).then((m: { id: string } | null) => m?.id ?? null);
const findHits = async (auth: AuthContext) =>
  ((await Q.findNodes(null, { query: TOKEN, mode: 'keyword' }, ctxOf(auth))).hits as { node: { memoryId: string } }[])
    .map((h) => h.node.memoryId).sort();

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({ data: { id: generateId(), name: 'own5398', urn: `own5398-${generateId().slice(-6)}` } });
  const handle = `otto-${generateId().slice(-6)}`;
  otto = { id: (await db.user.create({ data: { id: generateId(), githubId: 5_398_001, githubUsername: 'otto', handle } })).id, handle };
  stranger = await db.user.create({ data: { id: generateId(), githubId: 5_398_002, githubUsername: 'stranger', handle: `str-${generateId().slice(-6)}` } });
  orgApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'OrgApp', urn: `${org.urn}:orgapp` } as never });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'OtherApp', urn: `${org.urn}:otherapp` } as never });
  userApp = await db.app.create({ data: { id: generateId(), ownerUserId: otto.id, name: 'UserApp', urn: `${handle}:userapp` } as never });
  await db.appMember.create({ data: { appId: userApp.id, userId: otto.id, role: 'owner' } });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'A', urn: `${org.urn}:a5398`, organizationId: org.id } })).id;
});
afterEach(() => sessionKeyCache.clear());

describe('#5398 a pure App key reads and lists its own App\'s shared app-class memory', () => {
  it.each([
    ['a user-owned App (every surface red on main)', () => userApp],
    ['an org-owned App (the list red on main; the reads already held)', () => orgApp],
  ] as const)('%s: record, list, node reads, search, resolveUrn and MCP all admit', async (_n, which) => {
    const app = which();
    const own = await appMemory(app, 'own');
    const auth = keyAuth(app.id);
    // GraphQL
    expect(await recordRead(auth, own.id)).toBe(own.id);
    expect(await listIds(auth)).toEqual([own.id]);
    expect((await Q.node({}, { ref: nodeUrn(own) }, ctxOf(auth)))?.content).toBe('secret own');
    expect(await findHits(auth)).toEqual([own.id]);
    expect(await Q.resolveUrn(null, { urn: `hrn:mem:${own.urn}` }, ctxOf(auth))).toEqual({ kind: 'memory', id: own.id });
    // MCP: the access map (the list's source), the point gate, the batch gate and the real tools
    expect((await getMemoryAccess(db as never, auth)).get(own.id)).toBe('READ_ONLY');
    expect(await canReadMemory(db as never, auth, own.id)).toBe(true);
    expect([...(await filterReadableMemoryIds(db as never, auth, [own.id]))]).toEqual([own.id]);
    const mcp = createTestableMcpServer(auth);
    expect(await mcp.callToolText('hadron_list_memories', {})).toContain(own.urn);
    expect(await mcp.callToolText('hadron_get_node', { urn: nodeUrn(own) })).toContain('secret own');
  }, 30_000);

  it('the list equals the reads for the key (one parity pin over every shape in play)', async () => {
    const own = await appMemory(userApp, 'own');
    const second = await appMemory(userApp, 'second');
    const perUser = await appMemory(userApp, 'anon', { userMemoryOfAgentId: agentId });
    const foreign = await appMemory(otherApp, 'foreign');
    const auth = keyAuth(userApp.id);
    const candidates = [own, second, perUser, foreign];
    const readable: string[] = [];
    for (const m of candidates) if (await recordRead(auth, m.id)) readable.push(m.id);
    expect(readable.sort()).toEqual([own.id, second.id].sort());
    expect(await listIds(auth)).toEqual(readable);
    expect([...(await getMemoryAccess(db as never, auth)).keys()].sort()).toEqual(readable);
  }, 30_000);
});

describe('#5398 controls (green on main, stay green)', () => {
  /** Every refusal is the answer to a memory that does not exist. */
  const refusedLikeMissing = async (auth: AuthContext, m: Mem) => {
    const missing = { id: generateId(), urn: `${org.urn}:nosuchmemory`, name: 'x' };
    expect(await recordRead(auth, m.id)).toBeNull();
    expect(await recordRead(auth, missing.id)).toBeNull();
    expect(await Q.node({}, { ref: nodeUrn(m) }, ctxOf(auth))).toBeNull();
    expect(await Q.resolveUrn(null, { urn: `hrn:mem:${m.urn}` }, ctxOf(auth))).toBeNull();
    expect(await Q.resolveUrn(null, { urn: `hrn:mem:${missing.urn}` }, ctxOf(auth))).toBeNull();
    expect(await listIds(auth)).not.toContain(m.id);
    expect(await findHits(auth)).not.toContain(m.id);
    expect(await canReadMemory(db as never, auth, m.id)).toBe(false);
    expect((await getMemoryAccess(db as never, auth)).has(m.id)).toBe(false);
    const mcp = createTestableMcpServer(auth);
    const hidden = await mcp.callToolText('hadron_get_node', { urn: nodeUrn(m) });
    const absent = await mcp.callToolText('hadron_get_node', { urn: nodeUrn(missing) });
    expect(hidden).not.toContain('secret');
    expect(hidden.replaceAll(m.urn, 'X')).toBe(absent.replaceAll(missing.urn, 'X'));
  };

  it('another App\'s app-class memory is refused, byte-identical to a missing one', async () => {
    await appMemory(userApp, 'own');
    await refusedLikeMissing(keyAuth(userApp.id), await appMemory(otherApp, 'foreign'));
    await refusedLikeMissing(keyAuth(orgApp.id), await appMemory(otherApp, 'foreign2'));
  }, 30_000);

  it.each([
    ['a user-owned App', () => userApp],
    ['an org-owned App', () => orgApp],
  ] as const)('%s: its own per-user anonymous app-class row (userMemoryOfAgentId set) is refused like a missing one', async (_n, which) => {
    const app = which();
    await refusedLikeMissing(keyAuth(app.id), await appMemory(app, 'anon', { userMemoryOfAgentId: agentId }));
  }, 30_000);

  it.each([
    ['a user-owned App', () => userApp],
    ['an org-owned App', () => orgApp],
  ] as const)('%s: a Worker\'s working memory of the App is refused like a missing one', async (_n, which) => {
    const app = which();
    const working = await appMemory(app, 'working');
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Iris', slug: 'iris', memoryId: working.id } as never,
    });
    await refusedLikeMissing(keyAuth(app.id), working);
  }, 30_000);

  it('a user-owned row of an ORG App owned by somebody (not the App\'s owner) is refused like a missing one', async () => {
    const foreignOwned = await db.memory.create({
      data: {
        id: generateId(), name: 'otto-own', urn: `${otto.handle}:otto-own`, class: 'app', appId: orgApp.id, visibility: null,
        organizationId: null, ownerUserId: otto.id,
      } as never,
    });
    await db.node.create({ data: { id: generateId(), memoryId: foreignOwned.id, loc: LOC, name: `${TOKEN} x`, content: 'secret x' } });
    await refusedLikeMissing(keyAuth(orgApp.id), foreignOwned as Mem);
  }, 30_000);

  it('the arm\'s own predicate leaves out an org-owned app row carrying the App\'s id but another organization', async () => {
    // Direct pin on the predicate: on main the team-space fold (getAppTeamSpaceAccess) already admits such a row for the key,
    // since it does not compare organizations. That is pre-existing and outside this change; this arm adds nothing to it.
    const elsewhere = await db.organization.create({ data: { id: generateId(), name: 'else5398', urn: `else5398-${generateId().slice(-6)}` } });
    const stray = await db.memory.create({
      data: { id: generateId(), name: 'stray', urn: `${elsewhere.urn}:stray`, class: 'app', appId: orgApp.id, organizationId: elsewhere.id, visibility: null } as never,
    });
    expect(await ownAppMemoryIds(db as never, keyAuth(orgApp.id), [stray.id])).toEqual(new Set());
    const own = await appMemory(orgApp, 'own');
    expect(await ownAppMemoryIds(db as never, keyAuth(orgApp.id))).toEqual(new Set([own.id]));
  }, 30_000);

  it('a user-owned App: an app row carrying its id but owned by another person is refused like a missing one', async () => {
    const theirs = await db.memory.create({
      data: {
        id: generateId(), name: 'theirs', urn: `${otto.handle}:theirs`, class: 'app', appId: userApp.id, visibility: null,
        organizationId: null, ownerUserId: stranger.id,
      } as never,
    });
    await db.node.create({ data: { id: generateId(), memoryId: theirs.id, loc: LOC, name: `${TOKEN} theirs`, content: 'secret theirs' } });
    await refusedLikeMissing(keyAuth(userApp.id), theirs as Mem);
  }, 30_000);

  it('another class carrying the App\'s id (an App knowledge memory) is not in the arm', async () => {
    await refusedLikeMissing(keyAuth(orgApp.id), await appMemory(orgApp, 'know', { class: 'knowledge' }));
  }, 30_000);

  it('a soft-deleted own memory is refused like a missing one', async () => {
    const gone = await appMemory(userApp, 'gone');
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await refusedLikeMissing(keyAuth(userApp.id), gone);
  }, 30_000);

  it('the key cannot write its own App\'s memory', async () => {
    for (const app of [userApp, orgApp]) {
      const own = await appMemory(app, `w${app.id.slice(-4)}`);
      const auth = keyAuth(app.id);
      expect(await canWriteToMemory(db as never, auth, own.id)).toBe(false);
      await expect(M.createNode(null, { input: { memoryRef: own.id, loc: 'new', name: 'N' } }, ctxOf(auth))).rejects.toThrow();
      expect(await db.node.count({ where: { memoryId: own.id, loc: 'new' } })).toBe(0);
    }
  }, 30_000);

  it('a user (even the App\'s own owner with the App selected) gains nothing new; a stranger with the App selected gains nothing', async () => {
    const own = await appMemory(userApp, 'own');
    const strangerAuth = { userId: stranger.id, appId: userApp.id, roles: [], clientId: `user:${stranger.id}` } as AuthContext;
    await refusedLikeMissing(strangerAuth, own);
    const orgOwn = await appMemory(orgApp, 'orgown');
    await refusedLikeMissing(strangerAuth, orgOwn);
  }, 30_000);

  it('a session-bound key of the App gains nothing', async () => {
    const own = await appMemory(userApp, 'own');
    await refusedLikeMissing(keyAuth(userApp.id, { sessionId: generateId() }), own);
  }, 30_000);

  it('an impersonation in the App gains nothing', async () => {
    const own = await appMemory(userApp, 'own');
    const auth = keyAuth(userApp.id, { userId: stranger.id, impersonation: { orgId: org.id, actorUserId: otto.id } as never });
    expect(await recordRead(auth, own.id)).toBeNull();
    expect(await canReadMemory(db as never, auth, own.id)).toBe(false);
    expect((await getMemoryAccess(db as never, auth)).has(own.id)).toBe(false);
  }, 30_000);

  it('a userless run of a user-owned App gains nothing (the arm is the key\'s)', async () => {
    const own = await appMemory(userApp, 'own');
    const auth = { appId: userApp.id, roles: [], clientId: 'run:r5398' } as AuthContext;
    expect(await canReadMemory(db as never, auth, own.id)).toBe(false);
    expect((await getMemoryAccess(db as never, auth)).has(own.id)).toBe(false);
    expect(await recordRead(auth, own.id)).toBeNull();
  }, 30_000);

  it('a deleted or uninstalled App\'s key reads nothing of it', async () => {
    const own = await appMemory(userApp, 'own');
    await db.app.update({ where: { id: userApp.id }, data: { uninstalledAt: new Date() } });
    expect(await canReadMemory(db as never, keyAuth(userApp.id), own.id)).toBe(false);
    expect(await recordRead(keyAuth(userApp.id), own.id)).toBeNull();
    await db.app.update({ where: { id: userApp.id }, data: { uninstalledAt: null, deletedAt: new Date() } });
    expect(await canReadMemory(db as never, keyAuth(userApp.id), own.id)).toBe(false);
    expect(await recordRead(keyAuth(userApp.id), own.id)).toBeNull();
  }, 30_000);

  it('an org-owned App whose organization is soft-deleted: the arm admits nothing of it', async () => {
    // Pins the organization clause of the App-liveness check on the arm's own predicate (Bianca's SEC10 P3, mutant M11):
    // nothing else in the predicate refuses a deleted organization's rows, the tenant equality included.
    const own = await appMemory(orgApp, 'own');
    expect(await ownAppMemoryIds(db as never, keyAuth(orgApp.id))).toEqual(new Set([own.id]));
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await ownAppMemoryIds(db as never, keyAuth(orgApp.id))).toEqual(new Set());
    expect(await ownAppMemoryIds(db as never, keyAuth(orgApp.id), [own.id])).toEqual(new Set());
  }, 30_000);

  it.each([
    ['an org-owned App (reach unchanged from main)', () => orgApp],
    ['a user-owned App (the new reach)', () => userApp],
  ] as const)('%s: an encrypted own memory follows existing key behaviour, no content without a cached key', async (_n, which) => {
    // No new path decrypts for a key: the record is readable, the content needs a cached session key exactly as before.
    const app = which();
    const key = generateDataKey();
    const enc = await appMemory(app, 'enc', { isEncrypted: true });
    await db.node.deleteMany({ where: { memoryId: enc.id } });
    await db.node.create({
      data: { id: generateId(), memoryId: enc.id, loc: LOC, name: 'enc', ...encryptNodeFieldsWithKey({ content: 'secret enc' }, key) } as never,
    });
    const auth = keyAuth(app.id);
    expect(await recordRead(auth, enc.id)).toBe(enc.id);
    const uncached = await Q.node({}, { ref: nodeUrn(enc) }, ctxOf(auth)).then(
      (n: { content?: string } | null) => n?.content ?? null, (e: { extensions?: { code?: string }; name?: string }) => e.extensions?.code ?? e.name);
    expect(uncached).not.toBe('secret enc');
    sessionKeyCache.set('s5398', enc.id, key);
    expect((await Q.node({}, { ref: nodeUrn(enc) }, ctxOf(auth)))?.content).toBe('secret enc');
  }, 30_000);
});
