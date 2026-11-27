/**
 * #5321 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, `memory.read`; Holger 2026-11-27 afternoon: "The grant may be for all org
 * memories (org ADMIN and OWNER approve, create/issue anyone) or the grant names one or more memories. Then owner of that memory
 * approves."): the doors that make a `memory.read` grant. Creation admits exactly the two forms and only the grant's own App as
 * holder; the signer is judged by `MEMORY_READ_APPROVER`; the summary says which form the signer is giving. The READ these grants
 * allow is pinned in src/api/graphql/schema/resolvers.appReadGrant5321.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from './actions.js';
import { createPendingGrant, GrantCreateRefusal } from './create.js';
import { requireActionIssuer } from './issuers.js';
import { renderGrantSummary, GrantSummaryError } from './summary.js';
import { dropTestActions, seedWorld, type World } from './grantFixtures3668.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let w: World;
let manager: string; // manages the user-owned memory `kb` (its owner); an org READER
let reader: string; // reads `kb` through a share, manages nothing
let admin: string; // ADMIN of the App's organization
let kb: { id: string }; // a user-owned knowledge memory of `manager`
let kb2: { id: string }; // another one of `manager`
let theirs: { id: string }; // a user-owned knowledge memory of `reader`

const ctxOf = (userId: string, roles: string[] = []): Context => ({ db, userId, roles } as unknown as Context);
const create = (values: unknown, over: Record<string, unknown> = {}) => db.$transaction((tx) => createPendingGrant(tx, {
  appId: w.appId, requester: { userId: manager, workerId: null, sessionId: null }, holder: { kind: 'app', id: w.appId },
  action: 'memory.read', values, reason: 'r', canReadMemory: async () => true, ...over,
} as never));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e instanceof GrantCreateRefusal ? e.code : String(e));
const signer = (userId: string, values: unknown, roles: string[] = []) =>
  requireActionIssuer(ctxOf(userId, roles), 'memory.read', w.appId, values).then(() => 'OK', (e: any) => e?.extensions?.code ?? String(e));

async function userKb(owner: string) {
  return db.memory.create({ data: { id: generateId(), name: 'kb', urn: `u-${generateId().slice(-8)}:kb`, class: 'knowledge', visibility: null, ownerUserId: owner } as never });
}
async function orgMemory(data: Record<string, unknown>) {
  return db.memory.create({ data: { id: generateId(), name: 'm', urn: `${w.orgUrn}:m-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: w.orgId, ...data } as never });
}

beforeEach(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); // the MCP grant tools register only where signing is on
  await cleanDb(db);
  w = await seedWorld();
  await upsertPlatformActions(db);
  const person = async (h: string) => (await db.user.create({ data: { handle: `${h}-${generateId().slice(-6)}` } })).id;
  [manager, reader, admin] = [await person('mgr'), await person('rdr'), await person('adm')];
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: manager, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: reader, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: admin, role: 'ADMIN' } });
  kb = await userKb(manager);
  kb2 = await userKb(manager);
  theirs = await userKb(reader);
  await db.memoryShare.create({ data: { memoryId: kb.id, granteeId: reader, grantorId: manager, role: 'reader' } });
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('creation admits the two forms (cor:acl:140:02)', () => {
  it('form (b): one memory id, or a list of them, is stored as given', async () => {
    for (const v of [kb.id, [kb.id, kb2.id]]) {
      const id = await create({ memory: v });
      expect((await db.grant.findUniqueOrThrow({ where: { id } })).values).toEqual({ memory: v });
    }
  });

  it('form (a): the App\'s own organization id, as a single value', async () => {
    const id = await create({ memory: w.orgId });
    expect(await db.grant.findUniqueOrThrow({ where: { id } })).toMatchObject({ granteeAppId: w.appId, values: { memory: w.orgId }, activatedAt: null });
  });

  it('refuses the wildcard, an empty list, a repeat, another organization, the organization inside a list and a URN, with one answer', async () => {
    const other = await db.organization.create({ data: { name: 'o2', urn: `o2-${generateId().slice(0, 6)}.test` } });
    for (const v of ['*', [], [kb.id, kb.id], other.id, [w.orgId], [kb.id, w.orgId], `hrn:mem:x:kb`, ['*']]) {
      expect({ v, code: await code(create({ memory: v })) }).toEqual({ v, code: 'GRANT_VALUES_INVALID' });
    }
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });

  it('refuses a missing, deleted, unreadable, personal, private, encrypted or own-App memory with the one answer, storing nothing', async () => {
    const gone = await userKb(manager);
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const pers = await orgMemory({ class: 'personal', userId: manager, visibility: null });
    const priv = await orgMemory({ class: 'private', userId: manager, visibility: null });
    const enc = await orgMemory({ isEncrypted: true });
    const own = await orgMemory({ class: 'app', appId: w.appId, visibility: null });
    for (const id of [generateId(), gone.id, pers.id, priv.id, enc.id, own.id]) {
      expect({ id, code: await code(create({ memory: id })) }).toEqual({ id, code: 'GRANT_VALUES_INVALID' });
    }
    // Unreadable to the requester: the same answer, also inside a list.
    const unreadable = (over: unknown) => code(create({ memory: over }, { canReadMemory: async (m: string) => m !== theirs.id }));
    expect(await unreadable(theirs.id)).toBe('GRANT_VALUES_INVALID');
    expect(await unreadable([kb.id, theirs.id])).toBe('GRANT_VALUES_INVALID');
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });

  it('a per-user chat holding is never a target, for any class it takes (hadron-internal#88, cor:cht:010:02)', async () => {
    const { memoryReadTargetRefusal } = await import('./readGrant.js');
    const row = { id: generateId(), appId: null, organizationId: w.orgId, ownerUserId: null, userId: null, deletedAt: null, isEncrypted: false,
      isInstallMemory: false, workerOf: [] };
    for (const cls of ['knowledge', 'group']) {
      expect(await memoryReadTargetRefusal(db as never, w.appId, { ...row, class: cls, userMemoryOfAgentId: generateId() })).toBe('user-holding');
      expect(await memoryReadTargetRefusal(db as never, w.appId, { ...row, class: cls, userMemoryOfAgentId: null })).toBeNull(); // the control
    }
  });

  it('only the grant\'s own App holds it: a worker, an agent, a person and another App are refused', async () => {
    for (const holder of [{ kind: 'worker', id: w.workerId }, { kind: 'agent', id: w.agentId }, { kind: 'user', id: manager }, { kind: 'app', id: w.app2Id }]) {
      expect({ holder, code: await code(create({ memory: kb.id }, { holder })) }).toEqual({ holder, code: 'GRANT_HOLDER_NOT_ALLOWED' });
    }
  });

  it('GraphQL createGrant: a person who manages the App asks for it with an App holder; the row is born pending', async () => {
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: manager }, data: { role: 'ADMIN' } });
    const input = { appRef: w.appId, holderKind: 'APP' as const, holderRef: w.appId, action: 'memory.read', values: { memory: [kb.id, kb2.id] }, reason: 'r' };
    const out = await (resolvers.Mutation as any).createGrant({}, { input }, ctxOf(manager));
    expect(await db.grant.findUniqueOrThrow({ where: { id: out.id } })).toMatchObject({ granteeAppId: w.appId, action: 'memory.read', activatedAt: null });
    await expect((resolvers.Mutation as any).createGrant({}, { input: { ...input, values: { memory: '*' } } }, ctxOf(manager)))
      .rejects.toMatchObject({ extensions: { code: 'GRANT_VALUES_INVALID' } });
  });

  it('MCP hadron_create_grant names only a worker or an agent holder, so it cannot ask for a memory.read grant (as for secret.use)', async () => {
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: manager }, data: { role: 'ADMIN' } });
    const auth = { userId: manager, roles: [], clientId: `user:${manager}`, appId: w.appId, organizationId: w.orgId } as AuthContext;
    const s = createTestableMcpServer(auth, { sessionId: `g-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const out = await s.callToolText('hadron_create_grant', { app: w.appId, action: 'memory.read', values: { memory: kb.id }, holderKind: 'WORKER', holderRef: w.workerId, reason: 'r' });
    expect(out.toLowerCase()).toContain('grant_holder_not_allowed');
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });
});

describe('who signs (MEMORY_READ_APPROVER)', () => {
  it('form (b): the manager of every named memory signs; a reader of it, an org ADMIN who does not manage it and a platform admin do not', async () => {
    expect(await signer(manager, { memory: kb.id })).toBe('OK');
    expect(await signer(manager, { memory: [kb.id, kb2.id] })).toBe('OK');
    expect(await signer(reader, { memory: kb.id })).toBe('FORBIDDEN');
    expect(await signer(admin, { memory: kb.id })).toBe('FORBIDDEN');
    const platform = (await db.user.create({ data: { handle: `pa-${generateId().slice(-6)}`, roles: ['ADMIN'] } })).id;
    expect(await signer(platform, { memory: [theirs.id] }, ['ADMIN'])).not.toBe('OK');
  });

  it('form (b): one memory the signer does not manage refuses the whole list (one grant per manager)', async () => {
    expect(await signer(manager, { memory: [kb.id, theirs.id] })).toBe('FORBIDDEN');
    expect(await signer(reader, { memory: [theirs.id, kb.id] })).toBe('FORBIDDEN');
    expect(await signer(reader, { memory: [theirs.id] })).toBe('OK');
  });

  it('form (a): an ADMIN or OWNER of the App\'s organization signs, as a live member; a READER and a removed ADMIN do not', async () => {
    expect(await signer(admin, { memory: w.orgId })).toBe('OK');
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: manager }, data: { role: 'OWNER' } });
    expect(await signer(manager, { memory: w.orgId })).toBe('OK');
    expect(await signer(reader, { memory: w.orgId })).toBe('FORBIDDEN');
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: admin }, data: { deletedAt: new Date() } });
    expect(await signer(admin, { memory: w.orgId })).toBe('FORBIDDEN');
  });

  it('refuses another organization\'s id, the wildcard and an empty list for everyone', async () => {
    const other = await db.organization.create({ data: { name: 'o3', urn: `o3-${generateId().slice(0, 6)}.test` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: admin, role: 'ADMIN' } });
    for (const v of [other.id, '*', [], ['*']]) expect({ v, r: await signer(admin, { memory: v }) }).toEqual({ v, r: 'FORBIDDEN' });
  });
});

describe('the signed sentence says which form it is', () => {
  const action = () => PLATFORM_ACTIONS.find((a) => a.name === 'memory.read')!;
  const app = { urn: 'hrn:app:acme.com:eng' };
  it('names one memory, several memories in stored order, or all ORGANIZATION knowledge of the organization', () => {
    expect(renderGrantSummary({ action: action(), app, values: { memory: 'm1' }, refs: { m1: { urn: 'hrn:mem:acme.com:kb' } } }))
      .toBe('Let hrn:app:acme.com:eng, acting with no person behind it, read the memory hrn:mem:acme.com:kb, read only');
    expect(renderGrantSummary({ action: action(), app, values: { memory: ['m2', 'm1'] }, refs: { m1: { urn: 'hrn:mem:acme.com:kb' }, m2: { urn: 'hrn:mem:acme.com:notes' } } }))
      .toBe('Let hrn:app:acme.com:eng, acting with no person behind it, read the memories hrn:mem:acme.com:notes, hrn:mem:acme.com:kb, read only');
    expect(renderGrantSummary({ action: action(), app, values: { memory: 'o1' }, refs: { o1: { urn: 'hrn:org:acme.com' } } }))
      .toBe('Let hrn:app:acme.com:eng, acting with no person behind it, read all ORGANIZATION knowledge of hrn:org:acme.com, read only');
  });

  it('refuses an organization inside a list, an unresolved entry and the wildcard, never guessing', () => {
    const bad: Array<{ values: Record<string, unknown>; refs: Record<string, { urn: string }> }> = [
      { values: { memory: ['o1'] }, refs: { o1: { urn: 'hrn:org:acme.com' } } },
      { values: { memory: ['m1', 'o1'] }, refs: { m1: { urn: 'hrn:mem:acme.com:kb' }, o1: { urn: 'hrn:org:acme.com' } } },
      { values: { memory: 'm9' }, refs: {} },
      { values: { memory: '*' }, refs: {} },
    ];
    for (const b of bad) expect(() => renderGrantSummary({ action: action(), app, ...b })).toThrow(GrantSummaryError);
  });
});
