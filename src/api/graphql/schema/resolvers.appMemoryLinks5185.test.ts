/**
 * #5185 (A3 of #5182; cor:dmo:060:20, "An attached memory"): `attachMemoryToApp` LINKS a readable memory to an App and changes
 * nothing on it; `detachMemoryFromApp` removes links; a pure App key and a userless run READ a linked memory (never write it)
 * while its attacher reads it in their own right; `App.attachedMemories` lists the links.
 *
 * The reach is judged by ONE module (`src/lib/appMemoryLinks.ts`) for both surfaces, so each reach case runs through the MCP
 * gate (`canReadMemory`, `hadron_get_node`) AND the GraphQL gate (`getAccessibleMemoryIds`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds, holdsContentReadIndependently } from './resolvers.helpers.js';
import { registerOwnRightReader, linkedMemoryReach } from '../../../lib/appMemoryLinks.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess } from '../../../mcp/access-control.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let alice: string; // org reader, member of both Apps: the usual attacher
let bob: string; // org reader, member of the org App, no more
let carol: string; // outsider
let otto: string; // owner of the user-owned App
let orgApp: { id: string };
let userApp: { id: string };

const asUser = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as Context);
const keyAuth = (appId: string, extra: Partial<AuthContext> = {}): AuthContext => ({ appId, roles: [], clientId: `app:${appId}`, ...extra } as AuthContext);
const runAuth = (appId: string): AuthContext => ({ appId, roles: [], clientId: 'run:r1' } as AuthContext);
const attach = (c: Context, memoryRef: string, appRef: string) => M.attachMemoryToApp(null, { memoryRef, appRef }, c);
const detach = (c: Context, memoryRef: string, appRef: string) => M.detachMemoryFromApp(null, { memoryRef, appRef }, c);
const codeOf = (e: any) => e?.extensions?.code ?? e?.code;
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ code: codeOf(e), message: String(e.message) }));
const links = (memoryId: string) => db.appMemoryLink.findMany({ where: { memoryId }, orderBy: { attachedBy: 'asc' } });

async function memory(data: Record<string, unknown>) {
  return db.memory.create({
    data: { id: generateId(), name: 'm', urn: `${org.urn}:m-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id, ...data } as never,
  });
}
async function personal(userId: string, tenant: 'org' | 'user', klass: 'personal' | 'private' = 'personal') {
  return memory(tenant === 'org'
    ? { class: klass, userId, visibility: null }
    : { class: klass, userId, organizationId: null, ownerUserId: userId, visibility: null, urn: `hrn-test-${generateId().slice(-8)}` });
}
const judgeFor = async (appId: string, memoryId: string) => (await import('../../../lib/appMemoryLinks.js')).judgeAppLinks(db as never, appId, { onlyMemoryIds: [memoryId] });
async function reachFor(auth: AuthContext, memoryId: string) {
  const mcp = await canReadMemory(db as never, auth, memoryId);
  const graphql = (await getAccessibleMemoryIds({ db, ...auth } as unknown as Context, memoryId)).includes(memoryId);
  return { mcp, graphql };
}

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'links5185', graphName: 'base' });
  org = made.org;
  const person = async (n: number, h: string) =>
    (await db.user.create({ data: { id: generateId(), githubId: 5_185_000 + n, githubUsername: h, handle: `${h}-${generateId().slice(-6)}` } })).id;
  [alice, bob, carol, otto] = [await person(1, 'alice'), await person(2, 'bob'), await person(3, 'carol'), await person(4, 'otto')];
  for (const u of [alice, bob]) await db.orgMember.create({ data: { organizationId: org.id, userId: u, role: 'READER' } });
  orgApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'OrgApp', urn: `${org.urn}:orgapp` } as never });
  userApp = await db.app.create({ data: { id: generateId(), ownerUserId: otto, name: 'UserApp', urn: `otto-${generateId().slice(-6)}:userapp` } as never });
  await db.appMember.create({ data: { appId: orgApp.id, userId: alice, role: 'member' } });
  await db.appMember.create({ data: { appId: orgApp.id, userId: bob, role: 'member' } });
  await db.appMember.create({ data: { appId: userApp.id, userId: alice, role: 'member' } });
  await db.appMember.create({ data: { appId: userApp.id, userId: otto, role: 'owner' } });
});

describe('attachMemoryToApp: the door', () => {
  it('links a readable knowledge, personal and private memory, and the memory row is byte-identical', async () => {
    {
      const m = await memory({});
      const before = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
      const out = await attach(asUser(alice), m.id, orgApp.id);
      expect(out.id).toBe(m.id);
      expect(await db.memory.findUniqueOrThrow({ where: { id: m.id } })).toEqual(before);
      expect(await links(m.id)).toMatchObject([{ appId: orgApp.id, attachedBy: alice }]);
    }
    const own = await personal(alice, 'org');
    const privateOwn = await personal(alice, 'org', 'private');
    for (const m of [own, privateOwn]) {
      const before = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
      await attach(asUser(alice), m.id, orgApp.id);
      expect(await db.memory.findUniqueOrThrow({ where: { id: m.id } })).toEqual(before);
    }
  });

  it('links one memory into two Apps; detach from one leaves the other', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    await attach(asUser(alice), m.id, userApp.id);
    expect((await links(m.id)).map((l) => l.appId).sort()).toEqual([orgApp.id, userApp.id].sort());
    expect(await detach(asUser(alice), m.id, orgApp.id)).toBe(true);
    expect(await links(m.id)).toMatchObject([{ appId: userApp.id }]);
  });

  it('a link already held is success and writes nothing; two concurrent attaches make one row', async () => {
    const m = await memory({});
    await Promise.all([attach(asUser(alice), m.id, orgApp.id), attach(asUser(alice), m.id, orgApp.id)]);
    await attach(asUser(alice), m.id, orgApp.id);
    expect(await links(m.id)).toHaveLength(1);
  });

  it('refuses a system memory typed, an unreadable one as a missing one, in the table order', async () => {
    const sys = await memory({ class: 'system', visibility: null });
    await db.orgMember.create({ data: { organizationId: org.id, userId: carol, role: 'READER' } });
    // alice reads nothing of a system memory in her own right: the miss answers first.
    expect(await refusal(attach(asUser(alice), sys.id, orgApp.id))).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    // A platform admin reads it in their own right: now the class answers.
    const admin = await db.user.create({ data: { id: generateId(), githubId: 5_185_100, githubUsername: 'adm', roles: ['ADMIN'] } });
    await db.appMember.create({ data: { appId: orgApp.id, userId: admin.id, role: 'member' } });
    const err = await attach({ db, userId: admin.id, roles: ['ADMIN'] } as Context, sys.id, orgApp.id).then(() => null, (e: any) => e);
    expect(err?.extensions).toMatchObject({ code: 'UNSUPPORTED_MEMORY_CLASS', memoryClass: 'system' });
    expect(await links(sys.id)).toEqual([]);
    // Unknown, deleted and unreadable are one answer.
    const hidden = await personal(otto, 'user');
    const gone = await memory({});
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const norm = (r: { code: string; message: string } | null, id: string) => r && { code: r.code, message: r.message.split(id).join('<ref>') };
    const unknownId = generateId();
    const answers = [
      norm(await refusal(attach(asUser(alice), hidden.id, orgApp.id)), hidden.id),
      norm(await refusal(attach(asUser(alice), gone.id, orgApp.id)), gone.id),
      norm(await refusal(attach(asUser(alice), unknownId, orgApp.id)), unknownId),
    ];
    expect(answers[0]).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('person only: no user, an App key, a run, a worker session and an impersonation are refused', async () => {
    const m = await memory({});
    const noUser = await attach({ db, roles: [] } as Context, m.id, orgApp.id).then(() => null, (e: any) => e);
    expect(codeOf(noUser)).toBe('UNAUTHENTICATED');
    const shapes: Array<Partial<Context>> = [
      { appKeyId: 'k1' }, { sessionId: 's1' }, { sessionBindingRefused: true }, { impersonation: { orgId: org.id } as never },
      { clientId: 'run:r1' },
    ];
    const answers = await Promise.all(shapes.map((s) => refusal(attach(asUser(alice, s), m.id, orgApp.id))));
    for (const a of answers) expect(a).toMatchObject({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(await links(m.id)).toEqual([]);
  });

  it('the App side: unknown, deleted and not-a-member are the same FORBIDDEN bytes; an uninstalled App answers APP_UNINSTALLED', async () => {
    const m = await memory({});
    const deleted = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Gone', urn: `${org.urn}:gone`, deletedAt: new Date() } as never });
    await db.orgMember.create({ data: { organizationId: org.id, userId: carol, role: 'READER' } });
    const unknown = await refusal(attach(asUser(carol), m.id, generateId()));
    const del = await refusal(attach(asUser(carol), m.id, deleted.id));
    const nonMember = await refusal(attach(asUser(carol), m.id, orgApp.id));
    expect(del).toMatchObject({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(unknown).toEqual(del);
    expect(nonMember).toEqual(del);
    await db.app.update({ where: { id: orgApp.id }, data: { uninstalledAt: new Date() } });
    expect(await refusal(attach(asUser(alice), m.id, orgApp.id))).toMatchObject({ code: 'APP_UNINSTALLED' });
    // a non-member of an uninstalled App still gets the one FORBIDDEN, not APP_UNINSTALLED
    expect(await refusal(attach(asUser(carol), m.id, orgApp.id))).toEqual(del);
  });

  it('refuses a memory the attacher reads only through another App (own right, #1349)', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } as never });
    await db.appMember.create({ data: { appId: other.id, userId: alice, role: 'member' } });
    const team = await memory({ class: 'app', appId: other.id, visibility: null });
    expect(await refusal(attach(asUser(alice), team.id, orgApp.id))).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
  });
});

/** Hold the contested anchors on a separate connection, run `change` under them, and keep them until `release`. */
async function hold(anchors: Array<{ kind: 'app' | 'memory' | 'user' | 'org'; id: string }>, change: (tx: any) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held!: () => void;
  const isHeld = new Promise<void>((r) => { held = r; });
  const done = db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, anchors, 'exclusive');
    await change(tx);
    held();
    await gate;
  }, { timeout: 20_000 });
  await isHeld;
  return { release, done };
}

describe('attach waits for its revokers (the second of two writers really waits)', () => {
  it('attach vs a concurrent App delete: waits on the App anchor, then writes no link', async () => {
    const m = await memory({});
    const holder = await hold([{ kind: 'app', id: orgApp.id }], (tx) => tx.app.update({ where: { id: orgApp.id }, data: { deletedAt: new Date() } }));
    const racing = attach(asUser(alice), m.id, orgApp.id);
    try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { holder.release(); await holder.done; }
    await expect(racing).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' }, message: 'Forbidden' });
    expect(await links(m.id)).toEqual([]);
  });

  it('attach vs a concurrent uninstall: waits on the App anchor, then answers APP_UNINSTALLED and writes no link', async () => {
    const m = await memory({});
    const holder = await hold([{ kind: 'app', id: orgApp.id }], (tx) => tx.app.update({ where: { id: orgApp.id }, data: { uninstalledAt: new Date() } }));
    const racing = attach(asUser(alice), m.id, orgApp.id);
    try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { holder.release(); await holder.done; }
    await expect(racing).rejects.toMatchObject({ extensions: { code: 'APP_UNINSTALLED' } });
    expect(await links(m.id)).toEqual([]);
  });

  it('attach vs loss of membership: waits, then is refused', async () => {
    const m = await memory({});
    const holder = await hold([{ kind: 'app', id: orgApp.id }], (tx) => tx.appMember.delete({ where: { appId_userId: { appId: orgApp.id, userId: alice } } }));
    const racing = attach(asUser(alice), m.id, orgApp.id);
    try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { holder.release(); await holder.done; }
    await expect(racing).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' }, message: 'Forbidden' });
    expect(await links(m.id)).toEqual([]);
  });

  it('detach vs a transfer: the former owner, judged on the rows after the wait, removes nothing', async () => {
    const m = await personal(alice, 'org');
    await db.appMember.update({ where: { appId_userId: { appId: orgApp.id, userId: bob } }, data: { role: 'member' } });
    await db.appMemoryLink.createMany({ data: [{ appId: orgApp.id, memoryId: m.id, attachedBy: alice }, { appId: orgApp.id, memoryId: m.id, attachedBy: bob }] });
    const holder = await hold([{ kind: 'memory', id: m.id }], (tx) => tx.memory.update({ where: { id: m.id }, data: { userId: carol } }));
    const racing = detach(asUser(alice), m.id, orgApp.id);
    try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { holder.release(); await holder.done; }
    // alice is still the attacher of her own row only: she is no longer the owner, so bob's link stays.
    await expect(racing).resolves.toBe(true);
    expect((await links(m.id)).map((l) => l.attachedBy)).toEqual([bob]);
  });

  it('attach vs a transfer of the memory: waits on the memory anchor, then judges the new owner (the attacher no longer reads it)', async () => {
    const m = await personal(alice, 'org');
    const holder = await hold([{ kind: 'memory', id: m.id }], (tx) => tx.memory.update({ where: { id: m.id }, data: { userId: carol } }));
    const racing = attach(asUser(alice), m.id, orgApp.id);
    try { await waitForLockWaitersOfType(db, 'advisory', 1); } finally { holder.release(); await holder.done; }
    await expect(racing).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await links(m.id)).toEqual([]);
  });
});

describe('the reach of a link, on both surfaces', () => {
  it('a pure App key and a userless run read a linked org memory; nothing else does', async () => {
    const m = await memory({});
    expect(await reachFor(keyAuth(orgApp.id), m.id)).toEqual({ mcp: false, graphql: false });
    await attach(asUser(alice), m.id, orgApp.id);
    expect(await reachFor(keyAuth(orgApp.id), m.id)).toEqual({ mcp: true, graphql: true });
    expect(await reachFor(runAuth(orgApp.id), m.id)).toEqual({ mcp: true, graphql: true });
    // Another App's key gains nothing.
    expect(await reachFor(keyAuth(userApp.id), m.id)).toEqual({ mcp: false, graphql: false });
  });

  it('a user, an impersonation, a session-bound key, a refused binding and a run with a user id gain nothing from a link (both surfaces)', async () => {
    // alice's own user-owned knowledge memory: she reads it, bob does not, and she links it into the organization's App.
    const mine = await memory({ visibility: null, organizationId: null, ownerUserId: alice });
    await attach(asUser(alice), mine.id, orgApp.id);
    expect(await reachFor(keyAuth(orgApp.id), mine.id)).toEqual({ mcp: true, graphql: true }); // the control: the key reads it
    const shapes: Array<[string, AuthContext]> = [
      ['bob, App selected', { userId: bob, appId: orgApp.id, roles: [], clientId: `user:${bob}` } as AuthContext],
      ['bob, no selection', { userId: bob, roles: [], clientId: `user:${bob}` } as AuthContext],
      ['impersonation', keyAuth(orgApp.id, { impersonation: { orgId: org.id } as never })],
      ['session-bound key', keyAuth(orgApp.id, { sessionId: generateId() })],
      ['refused binding', keyAuth(orgApp.id, { sessionBindingRefused: true })],
      ['run with a user id', { ...runAuth(orgApp.id), userId: bob } as AuthContext],
    ];
    for (const [name, auth] of shapes) expect({ name, ...(await reachFor(auth, mine.id)) }).toEqual({ name, mcp: false, graphql: false });
  });

  it('a link grants READ only: the key cannot write the memory', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    expect(await canReadMemory(db as never, keyAuth(orgApp.id), m.id)).toBe(true);
    expect(await canWriteToMemory(db as never, keyAuth(orgApp.id), m.id)).toBe(false);
  });

  it('a link grants no write through GraphQL either: createNode, updateNode and deleteNode with the App key are refused', async () => {
    const m = await memory({});
    const node = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'wnote', name: 'W', content: 'body' } });
    await attach(asUser(alice), m.id, orgApp.id);
    const keyCtx = { db, appId: orgApp.id, appKeyId: 'k1', roles: [], clientId: `app:${orgApp.id}` } as unknown as Context;
    const denied = { code: 'FORBIDDEN', message: 'Forbidden: no write access to this memory' };
    expect(await refusal(M.createNode(null, { input: { memoryId: m.id, loc: 'new', name: 'N', content: 'x' } }, keyCtx))).toEqual(denied);
    expect(await refusal(M.updateNode(null, { input: { memoryId: m.id, loc: 'wnote', content: 'changed' } }, keyCtx))).toEqual(denied);
    expect(await refusal(M.deleteNode(null, { nodeRef: node.id }, keyCtx))).toEqual(denied);
    // The control: the same calls reach the write gate and pass it for someone who may write the memory, so the refusals
    // above are the gate's, not argument validation or a missing App key shape.
    const admin = await db.user.create({ data: { id: generateId(), githubId: 5_185_600, githubUsername: 'adm4', roles: ['ADMIN'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    const adminCtx = { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context;
    expect(await refusal(M.createNode(null, { input: { memoryId: m.id, loc: 'new', name: 'N', content: 'x' } }, adminCtx))).toBeNull();
    await db.node.deleteMany({ where: { memoryId: m.id, loc: 'new' } });
    expect(await db.node.count({ where: { memoryId: m.id } })).toBe(1);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('body');
  });

  it('hadron_get_node through the key reads a node of the linked memory', async () => {
    const m = await memory({});
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'note', name: 'N', content: 'linked-body-5185' } });
    const urn = `hrn:node:${m.urn.replace(/^hrn:mem:/, '')}:note`;
    expect(await createTestableMcpServer(keyAuth(orgApp.id)).callToolText('hadron_get_node', { urn })).not.toContain('linked-body-5185');
    await attach(asUser(alice), m.id, orgApp.id);
    expect(await createTestableMcpServer(keyAuth(orgApp.id)).callToolText('hadron_get_node', { urn })).toContain('linked-body-5185');
  });

  it('personal and private: only when the memory\'s owner is the App\'s owner', async () => {
    // (a) a member's own private memory linked into an organization's App: attach succeeds, the key gets nothing.
    const mine = await personal(alice, 'org', 'private');
    await attach(asUser(alice), mine.id, orgApp.id);
    expect(await links(mine.id)).toHaveLength(1);
    expect(await reachFor(keyAuth(orgApp.id), mine.id)).toEqual({ mcp: false, graphql: false });
    // (b) the same link made by the owner of a user-owned App: the key reads (personal), a run does not read private.
    const ottos = await personal(otto, 'user');
    const ottosPrivate = await personal(otto, 'user', 'private');
    await attach(asUser(otto), ottos.id, userApp.id);
    await attach(asUser(otto), ottosPrivate.id, userApp.id);
    expect(await reachFor(keyAuth(userApp.id), ottos.id)).toEqual({ mcp: true, graphql: true });
    expect(await reachFor(keyAuth(userApp.id), ottosPrivate.id)).toEqual({ mcp: true, graphql: true });
    expect((await reachFor(runAuth(userApp.id), ottosPrivate.id)).mcp).toBe(false);
    // (b2) the owner's memory attached by someone else who may read it (a grantee, an administrator): the owner did not link it.
    const shared = await personal(otto, 'user');
    await db.memoryShare.create({ data: { memoryId: shared.id, granteeId: alice, grantorId: otto, role: 'reader' } });
    await attach(asUser(alice), shared.id, userApp.id);
    expect(await links(shared.id)).toHaveLength(1);
    expect(await reachFor(keyAuth(userApp.id), shared.id)).toEqual({ mcp: false, graphql: false });
    await attach(asUser(otto), shared.id, userApp.id); // now the owner links it too: it reaches the key
    expect(await reachFor(keyAuth(userApp.id), shared.id)).toEqual({ mcp: true, graphql: true });
    // (c) another person's personal memory shared with the attacher grants the key nothing.
    const theirs = await personal(carol, 'user');
    await db.memoryShare.create({ data: { memoryId: theirs.id, granteeId: alice, grantorId: carol, role: 'reader' } });
    await attach(asUser(alice), theirs.id, userApp.id);
    expect(await links(theirs.id)).toHaveLength(1);
    expect(await reachFor(keyAuth(userApp.id), theirs.id)).toEqual({ mcp: false, graphql: false });
  });

  it('lapses once per way of losing read, restores with the read, and the row stays', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    const key = keyAuth(orgApp.id);
    // org membership removed
    await db.orgMember.updateMany({ where: { userId: alice, organizationId: org.id }, data: { deletedAt: new Date() } });
    expect(await reachFor(key, m.id)).toEqual({ mcp: false, graphql: false });
    await db.orgMember.updateMany({ where: { userId: alice, organizationId: org.id }, data: { deletedAt: null } });
    expect(await reachFor(key, m.id)).toEqual({ mcp: true, graphql: true });
    // the memory leaves her reach (visibility removed and moved to another tenant)
    await db.memory.update({ where: { id: m.id }, data: { organizationId: null, ownerUserId: carol, visibility: null } });
    expect(await reachFor(key, m.id)).toEqual({ mcp: false, graphql: false });
    expect(await links(m.id)).toHaveLength(1);
    // a share revoked: a personal memory of the user-owned App's owner is reached through the owner's own link only (no share
    // is involved), so the share way of losing read is pinned on the attacher's side: the grantee's link goes inert.
    const sharedMem = await personal(carol, 'user');
    await db.memoryShare.create({ data: { memoryId: sharedMem.id, granteeId: alice, grantorId: carol, role: 'reader' } });
    await attach(asUser(alice), sharedMem.id, userApp.id);
    expect((await judgeFor(userApp.id, sharedMem.id)).every((l) => !l.active)).toBe(true); // inert already: not the owner's link
    await db.memoryShare.deleteMany({ where: { memoryId: sharedMem.id } });
    expect((await links(sharedMem.id)).length).toBe(1);
    // a soft-deleted memory is inert too
    const m2 = await memory({});
    await attach(asUser(alice), m2.id, orgApp.id);
    await db.memory.update({ where: { id: m2.id }, data: { deletedAt: new Date() } });
    expect(await reachFor(key, m2.id)).toEqual({ mcp: false, graphql: false });
    // a deleted attacher grants nothing
    const m4 = await memory({});
    await attach(asUser(alice), m4.id, orgApp.id);
    expect(await reachFor(key, m4.id)).toEqual({ mcp: true, graphql: true });
    await db.user.update({ where: { id: alice }, data: { deletedAt: new Date() } });
    expect(await reachFor(key, m4.id)).toEqual({ mcp: false, graphql: false });
    expect((await judgeFor(orgApp.id, m4.id)).map((l) => l.active)).toEqual([false]); // the row is there, inert
    expect(await links(m4.id)).toHaveLength(1);
    await db.user.update({ where: { id: alice }, data: { deletedAt: null } });
    // an App that is uninstalled grants nothing
    const m3 = await memory({});
    await attach(asUser(alice), m3.id, orgApp.id);
    await db.app.update({ where: { id: orgApp.id }, data: { uninstalledAt: new Date() } });
    expect(await reachFor(key, m3.id)).toEqual({ mcp: false, graphql: false });
  });

  it('a link whose attacher reads only through another App grants nothing', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other2` } as never });
    await db.appMember.create({ data: { appId: other.id, userId: alice, role: 'member' } });
    const team = await memory({ class: 'app', appId: other.id, visibility: null });
    // A row written around the door (or left from before): the judge still refuses it.
    await db.appMemoryLink.create({ data: { appId: orgApp.id, memoryId: team.id, attachedBy: alice } });
    expect(await reachFor(keyAuth(orgApp.id), team.id)).toEqual({ mcp: false, graphql: false });
  });

  it('a system memory linked around the door reaches nothing, even for an attacher who reads it', async () => {
    const sys = await memory({ class: 'system', visibility: null });
    const admin = await db.user.create({ data: { id: generateId(), githubId: 5_185_101, githubUsername: 'adm2', roles: ['ADMIN'] } });
    // The control: an ordinary memory this admin reads reaches the key through their link; the system one does not.
    const plain = await memory({});
    await db.appMemoryLink.createMany({ data: [
      { appId: orgApp.id, memoryId: sys.id, attachedBy: admin.id },
      { appId: orgApp.id, memoryId: plain.id, attachedBy: admin.id },
    ] });
    expect(await reachFor(keyAuth(orgApp.id), plain.id)).toEqual({ mcp: true, graphql: true });
    expect(await reachFor(keyAuth(orgApp.id), sys.id)).toEqual({ mcp: false, graphql: false });
  });

  it('the key\'s memory listing (the access map) carries the linked memory READ_ONLY, and no other shape does', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    expect((await getMemoryAccess(db as never, keyAuth(orgApp.id))).get(m.id)).toBe('READ_ONLY');
    expect((await getMemoryAccess(db as never, keyAuth(userApp.id))).has(m.id)).toBe(false);
    expect((await getMemoryAccess(db as never, keyAuth(orgApp.id, { impersonation: { orgId: org.id } as never }))).has(m.id)).toBe(false);
  });
});

describe('detachMemoryFromApp', () => {
  it('who may detach, and the answers of the table', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    // bob reads the memory and has no authority over the link: FORBIDDEN; carol cannot read it: the missing-memory answer.
    expect(await refusal(detach(asUser(bob), m.id, orgApp.id))).toMatchObject({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(await refusal(detach(asUser(carol), m.id, orgApp.id))).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await links(m.id)).toHaveLength(1);
    // the App's manager removes every link of that memory in that App
    await db.appMember.update({ where: { appId_userId: { appId: orgApp.id, userId: bob } }, data: { role: 'owner' } });
    await attach(asUser(bob), m.id, orgApp.id);
    expect(await links(m.id)).toHaveLength(2);
    expect(await detach(asUser(bob), m.id, orgApp.id)).toBe(true);
    expect(await links(m.id)).toEqual([]);
    // no link, and the caller may detach: success, nothing written
    expect(await detach(asUser(bob), m.id, orgApp.id)).toBe(true);
  });

  it('an administrator of the memory\'s organization removes the links of that memory, with no say over the App', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    const other = await db.user.create({ data: { id: generateId(), githubId: 5_185_400, githubUsername: 'orgadmin', handle: `orgadmin-${generateId().slice(-6)}` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'ADMIN' } });
    expect(await detach(asUser(other.id), m.id, orgApp.id)).toBe(true);
    expect(await links(m.id)).toEqual([]);
  });

  it('the memory-org administrator arm stands alone: an admin of the memory\'s organization, with no relation to the App\'s, detaches', async () => {
    const orgB = await db.organization.create({ data: { id: generateId(), name: 'org-b-5185', urn: 'org-b-5185.example' } });
    const memB = await db.memory.create({ data: { id: generateId(), name: 'mb', urn: `${orgB.urn}:mb`, class: 'knowledge', visibility: 'PUBLIC', organizationId: orgB.id } as never });
    await attach(asUser(alice), memB.id, orgApp.id); // public knowledge of another tenant: alice reads it, links it into orgApp
    expect(await links(memB.id)).toHaveLength(1);
    const adminB = await db.user.create({ data: { id: generateId(), githubId: 5_185_700, githubUsername: 'admb', handle: `admb-${generateId().slice(-6)}` } });
    // no say over orgApp (not its org's member, not an App member): refused, can read the public memory, so FORBIDDEN
    expect(await refusal(detach(asUser(adminB.id), memB.id, orgApp.id))).toMatchObject({ code: 'FORBIDDEN' });
    await db.orgMember.create({ data: { organizationId: orgB.id, userId: adminB.id, role: 'ADMIN' } });
    expect(await detach(asUser(adminB.id), memB.id, orgApp.id)).toBe(true);
    expect(await links(memB.id)).toEqual([]);
  });

  it('the attacher removes their own link even after losing read; the memory never changes', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    const before = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    await db.orgMember.updateMany({ where: { userId: alice, organizationId: org.id }, data: { deletedAt: new Date() } });
    expect(await detach(asUser(alice), m.id, orgApp.id)).toBe(true);
    expect(await links(m.id)).toEqual([]);
    expect(await db.memory.findUniqueOrThrow({ where: { id: m.id } })).toEqual(before);
  });

  it('person only, and an unknown or deleted App is FORBIDDEN', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    expect(codeOf(await detach({ db, roles: [] } as Context, m.id, orgApp.id).then(() => null, (e: any) => e))).toBe('UNAUTHENTICATED');
    expect(await refusal(detach(asUser(alice, { appKeyId: 'k' }), m.id, orgApp.id))).toMatchObject({ code: 'FORBIDDEN' });
    const deleted = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Gone', urn: `${org.urn}:gone2`, deletedAt: new Date() } as never });
    expect(await refusal(detach(asUser(alice), m.id, deleted.id))).toMatchObject({ code: 'FORBIDDEN', message: 'Forbidden' });
  });
});

describe('detach is no App-existence oracle for a caller who cannot read the memory', () => {
  it('an existing, an unknown and a deleted App answer the same missing-memory error', async () => {
    const hidden = await personal(otto, 'user'); // alice cannot read it
    const deleted = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Gone', urn: `${org.urn}:gone3`, deletedAt: new Date() } as never });
    const norm = (r: { code: string; message: string } | null) => r && { code: r.code, message: r.message.split(hidden.id).join('<ref>') };
    const a = norm(await refusal(detach(asUser(alice), hidden.id, orgApp.id)));
    const b = norm(await refusal(detach(asUser(alice), hidden.id, generateId())));
    const c = norm(await refusal(detach(asUser(alice), hidden.id, deleted.id)));
    expect(a).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('GraphQL memory(ref:) for a linked knowledge memory of another tenant', () => {
  it('the key reads the record once linked, and not before', async () => {
    const m = await memory({});
    const keyCtx = { db, appId: userApp.id, appKeyId: 'k1', roles: [], clientId: `app:${userApp.id}` } as unknown as Context;
    const get = (id: string) => (resolvers.Query as any).memory(null, { ref: id }, keyCtx).then((r: any) => r?.id ?? null, () => null);
    expect(await get(m.id)).toBeNull();
    await attach(asUser(alice), m.id, userApp.id);
    expect(await get(m.id)).toBe(m.id);
  });
});

describe('GraphQL memory(ref:) for a linked personal memory of the App owner', () => {
  it('the key reads the record, a run does not read a private one, and an unlinked one stays missing', async () => {
    const ottos = await personal(otto, 'user');
    const ottosPrivate = await personal(otto, 'user', 'private');
    const keyCtx = { db, appId: userApp.id, appKeyId: 'k1', roles: [], clientId: `app:${userApp.id}` } as unknown as Context;
    const runCtx = { db, appId: userApp.id, roles: [], clientId: 'run:r1' } as unknown as Context;
    const get = (c: Context, id: string) => (resolvers.Query as any).memory(null, { ref: id }, c).then((r: any) => r?.id ?? null, () => null);
    expect(await get(keyCtx, ottos.id)).toBeNull();
    await attach(asUser(otto), ottos.id, userApp.id);
    await attach(asUser(otto), ottosPrivate.id, userApp.id);
    expect(await get(keyCtx, ottos.id)).toBe(ottos.id);
    expect(await get(keyCtx, ottosPrivate.id)).toBe(ottosPrivate.id);
    expect(await get(runCtx, ottosPrivate.id)).toBeNull();
  });
});

describe('the links of a soft-deleted memory', () => {
  it('cannot be detached (the memory is missing to every caller) and sit inert until restore', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    await db.memory.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    expect(await refusal(detach(asUser(alice), m.id, orgApp.id))).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await links(m.id)).toHaveLength(1);
    expect(await reachFor(keyAuth(orgApp.id), m.id)).toEqual({ mcp: false, graphql: false });
    await db.memory.update({ where: { id: m.id }, data: { deletedAt: null } });
    expect(await reachFor(keyAuth(orgApp.id), m.id)).toEqual({ mcp: true, graphql: true });
  });
});

describe('App.attachedMemories', () => {
  const field = (appId: string, c: Context) => (resolvers as any).App.attachedMemories({ id: appId }, {}, c);

  it('lists the links with their attacher and whether they count, to a viewer who reads the memory in their own right', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    const seen = await field(orgApp.id, asUser(bob));
    expect(seen).toMatchObject([{ attachedById: alice, active: true }]);
    expect(seen[0].memory.id).toBe(m.id);
    await db.orgMember.updateMany({ where: { userId: alice, organizationId: org.id }, data: { deletedAt: new Date() } });
    expect(await field(orgApp.id, asUser(bob))).toMatchObject([{ active: false }]);
  });

  it('omits an entry whose memory the viewer cannot read, and counts none', async () => {
    const mine = await personal(alice, 'org');
    await attach(asUser(alice), mine.id, orgApp.id);
    expect(await field(orgApp.id, asUser(bob))).toEqual([]);
    expect(await field(orgApp.id, asUser(alice))).toHaveLength(1);
  });

  // The roster guard in App.attachedMemories (appRosterWithheld) is a second line behind loadReadableNestedApp: every caller the guard
  // would withhold from (an impersonated owner, a member, an administrator) already gets [] before it runs, so no viewer reaches
  // attachedById: null today and the branch cannot be pinned from outside. The tests below pin the first line.
  it('a user-owned App\'s links are the owner\'s alone: neither a member nor a platform administrator sees them', async () => {
    const m = await memory({ visibility: 'PUBLIC' });
    await attach(asUser(alice), m.id, userApp.id);
    // the owner sees who attached it; another member of the user-owned App does not (#2089), nor learns it any other way.
    expect(await field(userApp.id, asUser(otto))).toMatchObject([{ attachedById: alice }]);
    // nobody else reaches a user-owned App's links: not a platform administrator, not another member (the roster guard in the
    // field stays as the second line)
    const admin = await db.user.create({ data: { id: generateId(), githubId: 5_185_500, githubUsername: 'adm3', roles: ['ADMIN'] } });
    expect(await field(userApp.id, asUser(admin.id, { roles: ['ADMIN'] }))).toEqual([]);
    expect(await field(userApp.id, asUser(alice))).toEqual([]);
  });

  it('reaches no other App\'s links', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, userApp.id);
    expect(await field(orgApp.id, asUser(alice))).toEqual([]);
  });
});

describe('the own-right reader is a registration, and a missing one fails closed', () => {
  it('with no reader registered every link counts for nothing, and one warning is logged', async () => {
    const m = await memory({});
    await attach(asUser(alice), m.id, orgApp.id);
    expect((await linkedMemoryReach(db as never, orgApp.id)).has(m.id)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerOwnRightReader(null);
    try {
      expect((await linkedMemoryReach(db as never, orgApp.id)).size).toBe(0);
      expect((await linkedMemoryReach(db as never, orgApp.id)).size).toBe(0);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('no_own_right_reader'))).toHaveLength(1);
    } finally {
      registerOwnRightReader(holdsContentReadIndependently as never);
      warn.mockRestore();
    }
    expect((await linkedMemoryReach(db as never, orgApp.id)).has(m.id)).toBe(true);
  });
});

describe('merge, erasure and hard deletes', () => {
  it('a merge moves the attacher, and a link both accounts hold is kept once', async () => {
    const m = await memory({});
    const m2 = await memory({});
    const twin = await db.user.create({ data: { id: generateId(), githubId: 5_185_200, githubUsername: 'twin', handle: `twin-${generateId().slice(-6)}` } });
    await db.appMemoryLink.createMany({ data: [
      { appId: orgApp.id, memoryId: m.id, attachedBy: alice },
      { appId: orgApp.id, memoryId: m.id, attachedBy: twin.id },
      { appId: orgApp.id, memoryId: m2.id, attachedBy: twin.id },
    ] });
    await mergeUsers(db as never, { sourceUserId: twin.id, targetUserId: alice } as never);
    expect((await db.appMemoryLink.findMany({ where: { appId: orgApp.id } })).map((l) => `${l.memoryId}:${l.attachedBy}`).sort())
      .toEqual([`${m.id}:${alice}`, `${m2.id}:${alice}`].sort());
  });

  it('a hard-deleted App, memory or attacher takes its rows', async () => {
    const m = await memory({});
    const m2 = await memory({});
    const temp = await db.user.create({ data: { id: generateId(), githubId: 5_185_300, githubUsername: 'temp', handle: `temp-${generateId().slice(-6)}` } });
    await db.appMemoryLink.createMany({ data: [
      { appId: orgApp.id, memoryId: m.id, attachedBy: alice },
      { appId: userApp.id, memoryId: m2.id, attachedBy: alice },
      { appId: orgApp.id, memoryId: m2.id, attachedBy: temp.id },
    ] });
    await db.user.delete({ where: { id: temp.id } });
    expect(await db.appMemoryLink.count({ where: { attachedBy: temp.id } })).toBe(0);
    await db.memory.delete({ where: { id: m.id } });
    expect(await db.appMemoryLink.count({ where: { memoryId: m.id } })).toBe(0);
    await db.app.delete({ where: { id: userApp.id } });
    expect(await db.appMemoryLink.count({ where: { appId: userApp.id } })).toBe(0);
  });
});
