/**
 * #1673 (DV-B / DX-C) — a strict-owner holding detached from a deleted App is
 * the owner's own FREE-STANDING memory over MCP (Rook's §10 re-ruling, option
 * A): `appId` and `userMemoryOfAgentId` both cleared, so the spec-034
 * free-standing rule applies instead of the legacy agent-scoped arm that
 * admitted any App installing the same Agent.
 *
 * Exercised after an App URN reclaim and after an account deletion, through
 * canReadMemory / canWriteToMemory and the real hadron_list_memories closure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { canReadMemory, canWriteToMemory } from './access-control.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/asset/purge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/asset/purge.js')>();
  return { ...actual, purgeCollectedAssetObjects: vi.fn(async () => undefined) };
});

beforeEach(async () => { await cleanDb(db); });

type Path = 'reclaim' | 'account deletion';

/**
 * The owner's personal + private holdings in an App of agent `juno`, which
 * the owner subscribes to (so the legacy arm WOULD have admitted another App
 * installing juno). `path` then deletes that App the way the PR does.
 */
async function detached(path: Path) {
  const actor = await db.user.create({ data: { handle: 'dh-actor', roles: ['ADMIN'] } });
  const owner = await db.user.create({ data: { handle: 'dh-owner' } });
  const other = await db.user.create({ data: { handle: 'dh-other' } });
  const orgOwner = await db.user.create({ data: { handle: 'dh-org-owner' } });
  const orgAdmin = await db.user.create({ data: { handle: 'dh-org-admin' } });
  const platformAdmin = await db.user.create({ data: { handle: 'dh-platform', roles: ['ADMIN'] } });
  const org = await db.organization.create({ data: { name: 'Detach', urn: 'detach.test' } });
  const elsewhere = await db.organization.create({ data: { name: 'Elsewhere', urn: 'elsewhere.test' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: actor.id, role: 'OWNER' },
    { organizationId: org.id, userId: orgOwner.id, role: 'OWNER' },
    { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: owner.id, role: 'READER' },
  ] });
  const juno = await db.agent.create({ data: { name: 'Juno', urn: 'detach.test:juno', organizationId: org.id } });
  const unrelatedAgent = await db.agent.create({ data: { name: 'Other', urn: 'detach.test:other', organizationId: org.id } });
  await createDbAgentSubscription(db, owner.id, juno.id);

  const doomed = await db.app.create({ data: {
    name: 'Doomed', urn: path === 'reclaim' ? 'detach.test:doomed' : 'dh-actor:doomed',
    ...(path === 'reclaim' ? { organizationId: org.id, deletedAt: new Date() } : { ownerUserId: actor.id }),
    appAgents: { create: { agentId: juno.id } },
  } });
  const holdings = [];
  for (const cls of ['personal', 'private'] as const) {
    holdings.push(await db.memory.create({ data: {
      name: `kept-${cls}-${generateId().slice(-6)}`, urn: `detach.test:kept-${cls}`, organizationId: org.id,
      appId: doomed.id, userId: owner.id, userMemoryOfAgentId: juno.id, class: cls,
    } }));
  }
  // A second App of the same Agent, in another org (the Juno multi-install).
  const second = await db.app.create({ data: {
    name: 'Second', urn: 'elsewhere.test:second', organizationId: elsewhere.id, appAgents: { create: { agentId: juno.id } },
  } });
  const unrelated = await db.app.create({ data: {
    name: 'Unrelated', urn: 'detach.test:unrelated', organizationId: org.id, appAgents: { create: { agentId: unrelatedAgent.id } },
  } });

  let replacement: { id: string } | null = null;
  if (path === 'reclaim') {
    replacement = await resolvers.Mutation.createApp({}, {
      orgRef: org.id, agentRef: juno.id, name: 'Doomed', urn: 'doomed',
    }, { db, userId: actor.id, roles: ['ADMIN'] });
    expect(replacement!.id).not.toBe(doomed.id);
  } else {
    await resolvers.Mutation.deleteUser({}, { userRef: actor.id }, { db, userId: actor.id, roles: ['ADMIN'] });
  }
  expect(await db.app.findUnique({ where: { id: doomed.id } })).toBeNull();

  const sessionOf = async (appId: string, userId: string | null) => {
    const memory = await db.memory.create({ data: {
      name: `session-${generateId().slice(-6)}`, urn: `detach.test:s-${generateId()}`, organizationId: org.id, appId, class: 'app',
    } });
    const s = await db.session.create({ data: { id: generateId(), appId, agentId: juno.id, memoryId: memory.id, ...(userId ? { userId } : {}) } });
    return s.id;
  };
  const appsOfJuno = [second.id, ...(replacement ? [replacement.id] : [])];
  return { owner, other, orgOwner, orgAdmin, platformAdmin, org, juno, holdings, second, unrelated, replacement, appsOfJuno, sessionOf };
}

const user = (userId: string, extra: Partial<AuthContext> = {}): AuthContext => ({ userId, roles: [], clientId: `user:${userId}`, ...extra });

async function reach(auth: AuthContext, memoryId: string, name: string) {
  const listing = await createTestableMcpServer(auth).callToolText('hadron_list_memories', {}).catch((e: Error) => e.message);
  return {
    read: await canReadMemory(db, auth, memoryId),
    write: await canWriteToMemory(db, auth, memoryId),
    listed: listing.includes(name),
  };
}

describe.each(['reclaim', 'account deletion'] as const)('a holding detached by %s', (path) => {
  it('keeps its owner, class, org and URN, with no App and no Agent', async () => {
    const f = await detached(path);
    for (const m of f.holdings) {
      expect(await db.memory.findUniqueOrThrow({ where: { id: m.id } })).toEqual({
        ...m, appId: null, userMemoryOfAgentId: null, updatedAt: expect.any(Date),
      });
    }
  });

  it('its owner reads, writes and lists it with no App and with an unrelated App selected', async () => {
    const f = await detached(path);
    for (const m of f.holdings) {
      for (const auth of [user(f.owner.id), user(f.owner.id, { appId: f.unrelated.id })]) {
        expect(await reach(auth, m.id, m.name)).toEqual({ read: true, write: true, listed: true });
      }
    }
  });

  it('every principal without the owner\'s userId is refused: other users, org and platform admins, App keys, keyed sessions, runs', async () => {
    const f = await detached(path);
    const refused: Array<[string, AuthContext]> = [
      ['another user', user(f.other.id)],
      ['an org OWNER', user(f.orgOwner.id, { roles: [] })],
      ['an org ADMIN', user(f.orgAdmin.id, { roles: [] })],
      ['a platform admin', user(f.platformAdmin.id, { roles: ['ADMIN'] })],
    ];
    for (const appId of f.appsOfJuno) {
      refused.push(
        [`a pure App key of ${appId}`, { appId, roles: [] }],
        [`an App-key-bound session of ${appId}`, { appId, sessionId: await f.sessionOf(appId, null), roles: [] }],
        [`a run of ${appId} with no on-behalf user`, { appId, clientId: `run:${generateId()}`, roles: [] }],
        [`a run of ${appId} acting for another user`, { appId, userId: f.other.id, clientId: `run:${generateId()}`, roles: [] }],
      );
    }
    for (const m of f.holdings) {
      for (const [who, auth] of refused) {
        expect({ who, ...(await reach(auth, m.id, m.name)) }).toEqual({ who, read: false, write: false, listed: false });
      }
    }
  });

  it('keeps user-bound sessions admitted; runs reach personal but never private (#1719 R5a)', async () => {
    const f = await detached(path);
    for (const m of f.holdings) {
      for (const appId of f.appsOfJuno) {
        const run: AuthContext = { appId, userId: f.owner.id, clientId: `run:${generateId()}`, roles: [] };
        const session: AuthContext = user(f.owner.id, { appId, sessionId: await f.sessionOf(appId, f.owner.id) });
        expect(await canReadMemory(db, run, m.id)).toBe(m.class === 'personal');
        expect(await canWriteToMemory(db, run, m.id)).toBe(m.class === 'personal');
        expect(await canReadMemory(db, session, m.id)).toBe(true);
        expect(await canWriteToMemory(db, session, m.id)).toBe(true);
      }
    }
  });
});

describe('MemoryShare on a detached personal holding (kept by design)', () => {
  it('an existing share is kept, and is honoured without the former Agent\'s subscription', async () => {
    const grantee = await db.user.create({ data: { handle: 'dh-grantee' } });
    const org = await db.organization.create({ data: { name: 'Share', urn: 'share.test' } });
    const actor = await db.user.create({ data: { handle: 'dh-share-actor', roles: ['ADMIN'] } });
    const owner = await db.user.create({ data: { handle: 'dh-share-owner' } });
    // An org-owned share is honoured for a co-member of the org (#778).
    await db.orgMember.createMany({ data: [
      { organizationId: org.id, userId: actor.id, role: 'OWNER' },
      { organizationId: org.id, userId: owner.id, role: 'READER' },
      { organizationId: org.id, userId: grantee.id, role: 'READER' },
    ] });
    const juno = await db.agent.create({ data: { name: 'Juno', urn: 'share.test:juno', organizationId: org.id } });
    const doomed = await db.app.create({ data: {
      name: 'Doomed', urn: 'share.test:doomed', organizationId: org.id, deletedAt: new Date(), appAgents: { create: { agentId: juno.id } },
    } });
    const m = await db.memory.create({ data: {
      name: 'shared', urn: 'share.test:shared', organizationId: org.id, appId: doomed.id, userId: owner.id, userMemoryOfAgentId: juno.id, class: 'personal',
    } });
    await db.memoryShare.create({ data: { memoryId: m.id, granteeId: grantee.id, grantorId: owner.id, role: 'reader' } });
    const asGrantee = { db, userId: grantee.id, roles: ['READER' as const] };
    // Before: the grantee holds no subscription to juno, so the share is not honoured.
    expect(await resolvers.Query.memory({}, { ref: m.id }, asGrantee)).toBeNull();

    await resolvers.Mutation.createApp({}, { orgRef: org.id, agentRef: juno.id, name: 'Doomed', urn: 'doomed' }, { db, userId: actor.id, roles: ['ADMIN'] });

    expect(await db.memoryShare.findUnique({ where: { memoryId_granteeId: { memoryId: m.id, granteeId: grantee.id } } }))
      .toMatchObject({ role: 'reader', grantorId: owner.id });
    expect((await resolvers.Query.memory({}, { ref: m.id }, asGrantee))?.id).toBe(m.id);
  });
});
