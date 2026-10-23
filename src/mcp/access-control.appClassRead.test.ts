import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1003 — an App's own members must be able to READ the App's team space: the
 * `class='app'` memory hosting `chats:team` and the `worklog` ledger.
 *
 * Before the fix, `getAppMemoryAccess` reached memories only by walking the
 * App's installed **Agents**, so it never saw a row linked by `Memory.appId`.
 * `canReadMemory` falls through to that map for every non-personal class, so a
 * plain App member's `hadron_get_node` on `chats:team` answered the
 * no-existence-oracle `Memory not found` — indistinguishable from a mistyped
 * URN, which is why it read as caller error for so long. A global ADMIN passed
 * only via the bypass sitting ABOVE the map check, so an admin-run probe could
 * not see the gap at all (the mis-framing in #990 item 3).
 *
 * The fixture mirrors the production shape (micromentor.org:mm-eng-team-shared):
 * an App with its Team Agent installed and an app-class memory owned by the App
 * AND keyed to that agent. FOUR shapes of app-class row can carry one App's
 * appId, and the tests below pin every one:
 *
 *   | Kind                  | sharedMemoryOfAgentId | userMemoryOfAgentId | workerOf | readable |
 *   |-----------------------|-----------------------|---------------------|----------|----------|
 *   | Team space (adopted)  | set                   | null                | none     | YES      |
 *   | Team space (legacy)   | null                  | null                | none     | YES      |
 *   | Worker working memory | null                  | null                | one      | holder/managers only |
 *   | Session memory        | null                  | SET                 | none     | NO       |
 *
 * The legacy row is why the predicate does not key on
 * `sharedMemoryOfAgentId: { not: null }` — that would leave pre-#723 unadopted
 * Apps with the exact symptom this fixes. The worker and session rows are why it
 * is not simply `appId + class='app'`: a Worker's casting-scoped working memory
 * (#974) has a holder/manager audience,
 * and a session memory is reachable only through its binding — admitting it
 * would hand every App member every anonymous end-user session (#934/#967).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import {
  cleanDb,
  createDbAppWithKey,
  createDbAppAgent,
  createDbAppMember,
} from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess, getWorkerMemoryAccess } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { canReadMemoryRecord, getAccessibleMemoryIds, requireMemoryWriteAccess, type Context } from '../api/graphql/schema/resolvers.helpers.js';
import { computeEffectiveAccess } from '../lib/auth/effectiveAccess.js';
import { sessionScopedMemoryIds } from '../lib/auth/sessionScopedMemoryIds.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'acr-org', urn: 'acr-org' },
  });
  orgId = org.id;
});

/**
 * App + installed Team Agent + a plain member holding App role `owner`, plus the
 * App's ADOPTED team space (`sharedMemoryOfAgentId` set) hosting `chats:team`.
 */
async function fixture() {
  const member = await db.user.create({ data: { id: generateId(), name: 'plain-member' } });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      name: 'Team Agent',
      urn: `${orgId}:team-agent`,
      organizationId: orgId,
    },
  });
  const { app } = await createDbAppWithKey(db, 'eng-team', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, member.id, 'owner');

  const shared = await db.memory.create({
    data: {
      class: 'app',
      id: generateId(),
      name: 'eng-team-shared',
      urn: `${orgId}:eng-team-shared`,
      organizationId: orgId,
      appId: app.id,
      sharedMemoryOfAgentId: agent.id,
    },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: shared.id,
      loc: 'chats:team',
      name: 'Team chat',
      nodeType: 'chat',
    },
  });
  return { member, agent, app, shared };
}

/** The auth context of a plain App member — no ADMIN, no OWNER. */
function memberAuth(memberId: string, appId: string): AuthContext {
  return {
    userId: memberId,
    appId,
    organizationId: orgId,
    roles: [],
    clientId: `user:${memberId}`,
  } as AuthContext;
}

describe('#1003 — App members can read the App team space', () => {
  it('the adopted team space is in the access map, readable, listed, and its nodes resolve', async () => {
    const { member, app, shared } = await fixture();
    const auth = memberAuth(member.id, app.id);

    expect((await getMemoryAccess(db, auth)).has(shared.id)).toBe(true);
    expect(await canReadMemory(db, auth, shared.id)).toBe(true);

    const listed = await createTestableMcpServer(auth).callToolText('hadron_list_memories', {});
    expect(listed).toContain('eng-team-shared');

    const read = await createTestableMcpServer(auth).callToolText('hadron_get_node', {
      urn: `hrn:node:${orgId}:eng-team-shared:chats:team`,
    });
    expect(read).not.toContain('Memory not found');
    expect(read).toContain('Team chat');
  });

  it('grants generic write to a human App participant', async () => {
    const { member, app, shared } = await fixture();
    const auth = memberAuth(member.id, app.id);

    expect((await getMemoryAccess(db, auth)).get(shared.id)).toBe('READ_WRITE');
    expect(await canWriteToMemory(db, auth, shared.id)).toBe(true);
  });

  it('a LEGACY team space (no sharedMemoryOfAgentId) is readable too', async () => {
    // What `workerOf: { none: {} }` buys over `sharedMemoryOfAgentId: { not: null }`:
    // pre-#723 rows that the adoption sweep (sharedMemoryAdoption.ts) has not
    // keyed yet must not stay unreadable.
    const { member, app } = await fixture();
    const legacy = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'eng-team-legacy',
        urn: `${orgId}:eng-team-legacy`,
        organizationId: orgId,
        appId: app.id,
        sharedMemoryOfAgentId: null,
      },
    });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).get(legacy.id)).toBe('READ_WRITE');
    expect(await canReadMemory(db, auth, legacy.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, legacy.id)).toBe(true);
  });

  it('a Worker working memory stays OUT of the map — exposure is not widened', async () => {
    // #974 casting-scoped memory: also an app-class row carrying this App's
    // appId. Ordinary App membership alone cannot read it.
    const { member, agent, app } = await fixture();
    const working = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'iris',
        urn: `${orgId}:eng-team-iris`,
        organizationId: orgId,
        appId: app.id,
      },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        id: generateId(),
        appId: app.id,
        agentId: agent.id,
        name: 'Iris',
        slug: 'iris',
        memoryId: working.id,
      },
    });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).has(working.id)).toBe(false);
    expect(await canReadMemory(db, auth, working.id)).toBe(false);
  });

  it('a SESSION memory stays OUT of the map — session isolation is not breached', async () => {
    // The anonymous scratch memory startAgentSession provisions reuses
    // class='app' for the App's bucket of records-through-an-agent. It is
    // reachable only through a session binding (sessionScopedMemoryIds, whose
    // contract says this map "excludes per-user memories entirely"), so
    // admitting it would hand every App member every anonymous end-user
    // session — the #934/#967 narrow-never-grant rule.
    const { member, agent, app } = await fixture();
    const scratch = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'Anonymous session',
        urn: `${orgId}:eng-team-anon`,
        organizationId: orgId,
        appId: app.id,
        userMemoryOfAgentId: agent.id,
      },
    });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).has(scratch.id)).toBe(false);
    expect(await canReadMemory(db, auth, scratch.id)).toBe(false);
  });

  it('a session-bound App KEY does not reach the team space (Codex P1 on PR #1004)', async () => {
    // A pure App-key principal with an active session is hard-isolated to
    // sessionScopedMemoryIds — the session memory plus the bound agent's reach.
    // Unlike the GraphQL getAccessibleMemoryIds, this module has no session
    // branch (hadron_get_node gates on canReadMemory alone), so the team-space
    // fold has to opt out for that shape or an anonymous end-user session could
    // read chats:team by URN.
    const { agent, app, shared } = await fixture();
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId: agent.id },
    });
    const appKeyInSession = {
      appId: app.id,
      sessionId: session.id,
      organizationId: orgId,
      roles: [],
      clientId: `app:${app.id}`,
    } as AuthContext;

    expect((await getMemoryAccess(db, appKeyInSession)).has(shared.id)).toBe(false);
    expect(await canReadMemory(db, appKeyInSession, shared.id)).toBe(false);

    const read = await createTestableMcpServer(appKeyInSession).callToolText('hadron_get_node', {
      urn: `hrn:node:${orgId}:eng-team-shared:chats:team`,
    });
    expect(read).toContain('Memory not found');
  });

  it('an App key WITHOUT a session still reaches the team space', async () => {
    // The complement of the guard above: the isolation is the session's, not
    // the App key's, so an unbound key keeps the reach this issue restores.
    const { app, shared } = await fixture();
    const appKey = {
      appId: app.id,
      organizationId: orgId,
      roles: [],
      clientId: `app:${app.id}`,
    } as AuthContext;

    expect((await getMemoryAccess(db, appKey)).get(shared.id)).toBe('READ_ONLY');
    expect(await canReadMemory(db, appKey, shared.id)).toBe(true);
    expect(await canWriteToMemory(db, appKey, shared.id)).toBe(false);
  });

  it("a MEMBER's own session binding does not cost them the team space (#934)", async () => {
    // A user credential's session binding is heartbeat attribution, never a
    // scope change — so the guard above is narrowed to the pure App-key shape.
    const { member, agent, app, shared } = await fixture();
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: member.id, agentId: agent.id },
    });
    const auth = { ...memberAuth(member.id, app.id), sessionId: session.id } as AuthContext;

    expect((await getMemoryAccess(db, auth)).get(shared.id)).toBe('READ_WRITE');
    expect(await canReadMemory(db, auth, shared.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, shared.id)).toBe(true);
  });

  it('a USER-OWNED App: the owner AND its members read its team space; another user-owned memory stays with its owner (spec 047, #1764)', async () => {
    // Copilot on PR #1004: every other fixture here is org-owned, so the
    // spec-047 blocker-2 guard (`row.ownerUserId !== app.ownerUserId`) was
    // never exercised. A user-owned App's team space is minted WITH the owner
    // on it (chat-scope owner-XOR), and an owner-scoped memory must not reach
    // a co-member's map or listing.
    const owner = await db.user.create({ data: { id: generateId(), name: 'app-owner' } });
    const coMember = await db.user.create({ data: { id: generateId(), name: 'co-member' } });
    const agent = await db.agent.create({
      data: { id: generateId(), name: 'Solo Agent', urn: `${orgId}:solo-agent`, ownerUserId: owner.id },
    });
    const app = await db.app.create({
      data: { id: generateId(), name: 'solo-app', urn: `solo-app`, ownerUserId: owner.id },
    });
    await createDbAppAgent(db, app.id, agent.id);
    await createDbAppMember(db, app.id, owner.id, 'owner');
    await createDbAppMember(db, app.id, coMember.id, 'member');

    const shared = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'solo-app-shared',
        urn: `${owner.id}:solo-app-shared`,
        ownerUserId: owner.id,
        appId: app.id,
        sharedMemoryOfAgentId: agent.id,
      },
    });

    const ownerAuth = {
      userId: owner.id, appId: app.id, roles: [], clientId: `user:${owner.id}`,
    } as AuthContext;
    const coMemberAuth = {
      userId: coMember.id, appId: app.id, roles: [], clientId: `user:${coMember.id}`,
    } as AuthContext;

    // The owner reaches it (the App shares its owner, so the guard passes).
    expect((await getMemoryAccess(db, ownerAuth)).has(shared.id)).toBe(true);
    expect(await canReadMemory(db, ownerAuth, shared.id)).toBe(true);

    // #1764 (Holger "A", #8151/#8155, cor:acl:010:01): a user-owned App's participants are its owner AND its
    // members, so the co-member reaches the TEAM SPACE — in the map, listed, readable, writable. The map, the point
    // gates and the listing surface must agree, as they did when the answer was "no".
    expect((await getMemoryAccess(db, coMemberAuth)).has(shared.id)).toBe(true);
    expect(await canReadMemory(db, coMemberAuth, shared.id)).toBe(true);
    expect(await canWriteToMemory(db, coMemberAuth, shared.id)).toBe(true);
    const listed = await createTestableMcpServer(coMemberAuth).callToolText(
      'hadron_list_memories',
      {},
    );
    expect(listed).toContain('solo-app-shared');

    // The spec-047 strictness it must NOT loosen: the owner's other user-owned memory, even one the App's agent
    // carries, is the owner's alone — not in the map, not listed, not readable, not writable by the co-member.
    const notes = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'solo-owner-notes', urn: `${owner.id}:solo-owner-notes`, ownerUserId: owner.id },
    });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: notes.id, role: 'read' } });
    expect((await getMemoryAccess(db, coMemberAuth)).has(notes.id)).toBe(false);
    expect(await canReadMemory(db, coMemberAuth, notes.id)).toBe(false);
    expect(await canWriteToMemory(db, coMemberAuth, notes.id)).toBe(false);
    expect(await createTestableMcpServer(coMemberAuth).callToolText('hadron_list_memories', {})).not.toContain('solo-owner-notes');
  });

  it('a user-owned App Worker holder reaches only their working memory (#1513)', async () => {
    const owner = await db.user.create({ data: { id: generateId(), name: 'personal-app-owner' } });
    const holder = await db.user.create({ data: { id: generateId(), name: 'personal-worker-holder' } });
    const member = await db.user.create({ data: { id: generateId(), name: 'personal-app-member' } });
    const agent = await db.agent.create({ data: {
      id: generateId(), name: 'Personal Agent', urn: `${owner.id}:agent`, ownerUserId: owner.id,
    } });
    const app = await db.app.create({ data: {
      id: generateId(), name: 'personal-app', urn: `${owner.id}:app`, ownerUserId: owner.id,
    } });
    await createDbAppAgent(db, app.id, agent.id);
    await createDbAppMember(db, app.id, member.id, 'member');
    const makeMemory = (
      name: string,
      extra: { sharedMemoryOfAgentId?: string; userMemoryOfAgentId?: string } = {},
    ) => db.memory.create({ data: {
      id: generateId(), class: 'app', name, urn: `${owner.id}:${name}`,
      ownerUserId: owner.id, appId: app.id, ...extra,
    } });
    const working = await makeMemory('personal-worker');
    const team = await makeMemory('personal-team', { sharedMemoryOfAgentId: agent.id });
    const scratch = await makeMemory('personal-session', { userMemoryOfAgentId: agent.id });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS,
      id: generateId(), appId: app.id, agentId: agent.id, name: 'Worker', slug: 'worker',
      memoryId: working.id, heldByUserId: holder.id,
    } });
    await db.node.create({ data: {
      id: generateId(), memoryId: working.id, loc: 'note', name: 'Worker note',
    } });
    const workingRow = await db.memory.findUniqueOrThrow({ where: { id: working.id }, include: { workerOf: true } });
    const holderAuth = { userId: holder.id, roles: [] } as AuthContext;
    const memberAuth = { userId: member.id, roles: ['ADMIN'] } as AuthContext;
    const ownerAuth = { userId: owner.id, roles: [] } as AuthContext;

    expect((await getMemoryAccess(db, holderAuth)).get(working.id)).toBe('READ_WRITE');
    expect(await canReadMemory(db, holderAuth, working.id)).toBe(true);
    expect(await canWriteToMemory(db, holderAuth, working.id)).toBe(true);
    expect(await createTestableMcpServer(holderAuth).callToolText('hadron_list_memories', {}))
      .toContain('personal-worker');
    expect(await createTestableMcpServer(holderAuth).callToolText('hadron_get_node', {
      urn: `hrn:node:${owner.id}:personal-worker:note`,
    })).toContain('Worker note');
    expect(await getAccessibleMemoryIds({ db, ...holderAuth } as Context, working.id)).toContain(working.id);
    expect(await getAccessibleMemoryIds({ db, ...holderAuth, roles: ['ADMIN'] } as Context, working.id))
      .toContain(working.id);
    expect(await canReadMemoryRecord({ db, ...holderAuth } as Context, working)).toBe(true);
    expect(await resolvers.Memory.app(working, {}, { db, ...holderAuth } as Context)).toBeNull();
    const eagerWorking = await db.memory.findUniqueOrThrow({
      where: { id: working.id }, include: { app: true },
    });
    expect(await resolvers.Memory.app(eagerWorking, {}, { db, ...holderAuth } as Context)).toBeNull();
    await expect(requireMemoryWriteAccess({ db, ...holderAuth } as Context, working.id)).resolves.toBeUndefined();
    expect((await computeEffectiveAccess(db, { id: holder.id, roles: [] },
      { kind: 'memory', memory: workingRow })).canWrite).toBe(true);

    for (const memory of [team, scratch]) {
      expect(await canReadMemory(db, holderAuth, memory.id)).toBe(false);
      expect(await canWriteToMemory(db, holderAuth, memory.id)).toBe(false);
      expect(await getAccessibleMemoryIds({ db, ...holderAuth } as Context, memory.id)).not.toContain(memory.id);
    }
    for (const principal of [memberAuth, { userId: generateId(), roles: [] } as AuthContext]) {
      expect(await canReadMemory(db, principal, working.id)).toBe(false);
      expect(await canWriteToMemory(db, principal, working.id)).toBe(false);
      expect(await getAccessibleMemoryIds({ db, ...principal } as Context, working.id)).not.toContain(working.id);
      expect(await canReadMemoryRecord({ db, ...principal } as Context, working)).toBe(false);
    }
    expect(await canReadMemory(db, ownerAuth, working.id)).toBe(true);
    expect(await canWriteToMemory(db, ownerAuth, working.id)).toBe(true);
    expect(await getWorkerMemoryAccess(db, ownerAuth)).toContain(working.id);
    expect(await resolvers.Memory.app(working, {}, { db, ...ownerAuth } as Context))
      .toMatchObject({ id: app.id });
    expect((await computeEffectiveAccess(db, { id: owner.id, roles: [] },
      { kind: 'memory', memory: workingRow })).canWrite).toBe(true);
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: null } });
    expect(await canReadMemory(db, holderAuth, working.id)).toBe(false);
    expect(await canWriteToMemory(db, holderAuth, working.id)).toBe(false);
    expect(await getAccessibleMemoryIds({ db, ...holderAuth } as Context, working.id)).not.toContain(working.id);
    expect(await canReadMemory(db, ownerAuth, working.id)).toBe(true);

    // A malformed cross-tenant pointer must not turn a foreign user's memory
    // into this Worker's holding merely because the appId and holder match.
    const foreignOwner = await db.user.create({ data: { id: generateId(), name: 'foreign-owner' } });
    const foreignMemory = await db.memory.create({ data: {
      id: generateId(), class: 'app', name: 'foreign-worker', urn: `${foreignOwner.id}:foreign-worker`,
      ownerUserId: foreignOwner.id, appId: app.id,
    } });
    await db.worker.update({ where: { id: worker.id }, data: {
      memoryId: foreignMemory.id, heldByUserId: holder.id,
    } });
    expect(await getWorkerMemoryAccess(db, holderAuth)).not.toContain(foreignMemory.id);
    expect(await canReadMemory(db, holderAuth, foreignMemory.id)).toBe(false);
    expect(await canWriteToMemory(db, holderAuth, foreignMemory.id)).toBe(false);
    expect(await getAccessibleMemoryIds({ db, ...holderAuth } as Context, foreignMemory.id))
      .not.toContain(foreignMemory.id);

    // Retirement leaves the casting and its hold recorded, but ends holder access.
    await db.worker.update({ where: { id: worker.id }, data: {
      memoryId: working.id, retiredAt: new Date(),
    } });
    const retiredWorking = await db.memory.findUniqueOrThrow({
      where: { id: working.id }, include: { workerOf: true },
    });
    expect(await getWorkerMemoryAccess(db, holderAuth)).not.toContain(working.id);
    expect(await canReadMemory(db, holderAuth, working.id)).toBe(false);
    expect(await canWriteToMemory(db, holderAuth, working.id)).toBe(false);
    expect((await getMemoryAccess(db, holderAuth)).has(working.id)).toBe(false);
    expect(await getAccessibleMemoryIds({ db, ...holderAuth } as Context, working.id))
      .not.toContain(working.id);
    expect(await canReadMemoryRecord({ db, ...holderAuth } as Context, retiredWorking)).toBe(false);
    await expect(requireMemoryWriteAccess({ db, ...holderAuth } as Context, working.id))
      .rejects.toThrow();
    expect((await computeEffectiveAccess(db, { id: holder.id, roles: [] },
      { kind: 'memory', memory: retiredWorking })).canWrite).toBe(false);
    expect(await canReadMemory(db, ownerAuth, working.id)).toBe(true);
  });

  it('org CONTRIBUTOR without AppMember can write a team row; revoked membership cannot', async () => {
    const { shared } = await fixture();
    const contributor = await db.user.create({ data: { id: generateId(), name: 'contributor' } });
    const member = await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
    const auth = { userId: contributor.id, roles: [] } as AuthContext;
    expect(await canWriteToMemory(db, auth, shared.id)).toBe(true);
    await expect(requireMemoryWriteAccess({ db, ...auth } as Context, shared.id)).resolves.toBeUndefined();
    const teamRow = await db.memory.findUniqueOrThrow({ where: { id: shared.id }, include: { workerOf: true } });
    expect((await computeEffectiveAccess(db, { id: contributor.id, roles: [] },
      { kind: 'memory', memory: teamRow })).canWrite).toBe(true);

    await db.orgMember.update({ where: { id: member.id }, data: { deletedAt: new Date() } });
    expect(await canWriteToMemory(db, auth, shared.id)).toBe(false);
    await expect(requireMemoryWriteAccess({ db, ...auth } as Context, shared.id)).rejects.toThrow('Forbidden');
  });

  it('an org READER cannot write a team row, while an org ADMIN can', async () => {
    const { shared } = await fixture();
    const reader = await db.user.create({ data: { id: generateId(), name: 'reader' } });
    const admin = await db.user.create({ data: { id: generateId(), name: 'org-admin' } });
    for (const [userId, role] of [[reader.id, 'READER'], [admin.id, 'ADMIN']] as const) {
      await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId, role } });
    }
    expect(await canWriteToMemory(db, { userId: reader.id, roles: [] }, shared.id)).toBe(false);
    expect(await canWriteToMemory(db, { userId: admin.id, roles: [] }, shared.id)).toBe(true);
  });

  it('an AppMember without org role writes the team row, not Worker or session rows', async () => {
    const { member, agent, app, shared } = await fixture();
    const workerMemory = await db.memory.create({ data: {
      id: generateId(), class: 'app', name: 'worker', urn: `${orgId}:worker`,
      organizationId: orgId, appId: app.id,
    } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS,
      id: generateId(), appId: app.id, agentId: agent.id,
      name: 'Worker', slug: 'worker', memoryId: workerMemory.id,
    } });
    await db.agentMemoryItem.create({ data: {
      agentId: agent.id, memoryId: workerMemory.id, role: 'read-write',
    } });
    const sessionMemory = await db.memory.create({ data: {
      id: generateId(), class: 'app', name: 'session', urn: `${orgId}:session`,
      organizationId: orgId, appId: app.id, userMemoryOfAgentId: agent.id,
    } });
    const auth = { userId: member.id, roles: [] } as AuthContext;
    expect(await canWriteToMemory(db, auth, shared.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, workerMemory.id)).toBe(false);
    expect(await canReadMemory(db, auth, workerMemory.id)).toBe(false);
    expect(await canWriteToMemory(db, auth, sessionMemory.id)).toBe(false);
    const workerRecord = await db.memory.findUniqueOrThrow({ where: { id: workerMemory.id } });
    const sessionRecord = await db.memory.findUniqueOrThrow({ where: { id: sessionMemory.id } });
    expect(await canReadMemoryRecord({ db, ...auth } as Context, workerRecord)).toBe(false);
    expect(await canReadMemoryRecord({ db, ...auth } as Context, sessionRecord)).toBe(false);
    const platformAdmin = { userId: member.id, roles: ['ADMIN'] as const } as AuthContext;
    expect(await canWriteToMemory(db, platformAdmin, workerMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, platformAdmin, sessionMemory.id)).toBe(true);
    for (const [id, expected] of [[shared.id, true], [workerMemory.id, false], [sessionMemory.id, false]] as const) {
      const row = await db.memory.findUniqueOrThrow({ where: { id }, include: { workerOf: true } });
      expect((await computeEffectiveAccess(db, { id: member.id, roles: [] },
        { kind: 'memory', memory: row })).canWrite).toBe(expected);
    }
    for (const id of [workerMemory.id, sessionMemory.id]) {
      await expect(requireMemoryWriteAccess({ db, ...auth } as Context, id)).rejects.toThrow('Forbidden');
    }

    // The current holder and an org ADMIN manage this Worker's memory;
    // ordinary App membership never grants that working-state access.
    const holder = await db.user.create({ data: { id: generateId(), name: 'holder' } });
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id } });
    const manager = await db.user.create({ data: { id: generateId(), name: 'manager' } });
    const managerRole = await db.orgMember.create({ data: {
      id: generateId(), organizationId: orgId, userId: manager.id, role: 'ADMIN',
    } });
    const contributor = await db.user.create({ data: { id: generateId(), name: 'contributor' } });
    await db.orgMember.create({ data: {
      id: generateId(), organizationId: orgId, userId: contributor.id, role: 'CONTRIBUTOR',
    } });
    const contributorAuth = { userId: contributor.id, roles: [] } as AuthContext;
    expect(await canReadMemory(db, contributorAuth, workerMemory.id)).toBe(false);
    expect(await canWriteToMemory(db, contributorAuth, workerMemory.id)).toBe(false);
    await expect(requireMemoryWriteAccess({ db, ...contributorAuth } as Context, workerMemory.id))
      .rejects.toThrow('Forbidden');
    const contributorRow = await db.memory.findUniqueOrThrow({
      where: { id: workerMemory.id }, include: { workerOf: true },
    });
    expect((await computeEffectiveAccess(db, { id: contributor.id, roles: [] },
      { kind: 'memory', memory: contributorRow })).canWrite).toBe(false);
    for (const userId of [holder.id, manager.id]) {
      const principal = { userId, roles: [] } as AuthContext;
      expect(await canReadMemory(db, principal, workerMemory.id)).toBe(true);
      expect(await canWriteToMemory(db, principal, workerMemory.id)).toBe(true);
      expect(await getAccessibleMemoryIds({ db, ...principal } as Context, workerMemory.id))
        .toContain(workerMemory.id);
      expect(await canReadMemoryRecord({ db, ...principal } as Context, workerRecord)).toBe(true);
      await expect(requireMemoryWriteAccess({ db, ...principal } as Context, workerMemory.id))
        .resolves.toBeUndefined();
      const row = await db.memory.findUniqueOrThrow({ where: { id: workerMemory.id }, include: { workerOf: true } });
      expect((await computeEffectiveAccess(db, { id: userId, roles: [] },
        { kind: 'memory', memory: row })).canWrite).toBe(true);
      expect(await canWriteToMemory(db, principal, sessionMemory.id)).toBe(false);
    }
    // Retirement ends the recorded holder's grant, but the App manager keeps
    // access to the casting's working memory.
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    const retiredHolder = { userId: holder.id, roles: [] } as AuthContext;
    const managerAuth = { userId: manager.id, roles: [] } as AuthContext;
    expect(await getWorkerMemoryAccess(db, retiredHolder)).not.toContain(workerMemory.id);
    expect(await canWriteToMemory(db, retiredHolder, workerMemory.id)).toBe(false);
    expect(await getWorkerMemoryAccess(db, managerAuth)).toContain(workerMemory.id);
    expect(await canReadMemory(db, managerAuth, workerMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, managerAuth, workerMemory.id)).toBe(true);
    expect(await getAccessibleMemoryIds({ db, ...managerAuth } as Context, workerMemory.id))
      .toContain(workerMemory.id);
    const retiredWorkerRow = await db.memory.findUniqueOrThrow({
      where: { id: workerMemory.id }, include: { workerOf: true },
    });
    expect((await computeEffectiveAccess(db, { id: manager.id, roles: [] },
      { kind: 'memory', memory: retiredWorkerRow })).canWrite).toBe(true);
    await db.orgMember.update({ where: { id: managerRole.id }, data: { deletedAt: new Date() } });
    expect(await canWriteToMemory(db, { userId: manager.id, roles: [] }, workerMemory.id)).toBe(false);

    const session = await db.session.create({ data: {
      id: generateId(), appId: app.id, agentId: agent.id, memoryId: sessionMemory.id,
    } });
    const appKey = { appId: app.id, sessionId: session.id, roles: [] } as AuthContext;
    expect(await canReadMemory(db, appKey, sessionMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, appKey, sessionMemory.id)).toBe(true);
    expect(await canReadMemory(db, appKey, shared.id)).toBe(false);
    expect(await canWriteToMemory(db, appKey, shared.id)).toBe(false);
    expect(await canWriteToMemory(db, appKey, workerMemory.id)).toBe(false);
    await expect(requireMemoryWriteAccess({ db, ...appKey } as Context, sessionMemory.id)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess({ db, ...appKey } as Context, shared.id)).rejects.toThrow('Forbidden');
    const misbound = await db.session.create({ data: {
      id: generateId(), appId: app.id, agentId: agent.id, memoryId: shared.id,
    } });
    expect(await sessionScopedMemoryIds(db, app.id, misbound.id)).not.toContain(shared.id);
    expect(await getAccessibleMemoryIds({ db, appId: app.id, sessionId: misbound.id } as Context, shared.id))
      .not.toContain(shared.id);
    expect(await canReadMemory(db, { appId: app.id, sessionId: misbound.id }, shared.id)).toBe(false);
    expect(await canWriteToMemory(db,
      { appId: app.id, sessionId: misbound.id, roles: [] }, shared.id)).toBe(false);
    const elevatedBoundKey = {
      appId: app.id, sessionId: misbound.id, roles: ['ADMIN'] as const,
    } as AuthContext;
    expect(await canReadMemory(db, elevatedBoundKey, shared.id)).toBe(false);
    expect(await canWriteToMemory(db, elevatedBoundKey, shared.id)).toBe(false);
    expect(await canReadMemoryRecord({ db, ...elevatedBoundKey } as Context,
      await db.memory.findUniqueOrThrow({ where: { id: shared.id } }))).toBe(false);
    await expect(requireMemoryWriteAccess({ db, ...elevatedBoundKey } as Context, shared.id))
      .rejects.toThrow('Forbidden');
    const workerMisbound = await db.session.create({ data: {
      id: generateId(), appId: app.id, agentId: agent.id, memoryId: workerMemory.id,
    } });
    expect(await sessionScopedMemoryIds(db, app.id, workerMisbound.id)).not.toContain(workerMemory.id);
    expect(await canReadMemory(db, { appId: app.id, sessionId: workerMisbound.id }, workerMemory.id)).toBe(false);
  });

  it('a soft-deleted team space is not readable', async () => {
    const { member, app, shared } = await fixture();
    await db.memory.update({ where: { id: shared.id }, data: { deletedAt: new Date() } });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).has(shared.id)).toBe(false);
    expect(await canReadMemory(db, auth, shared.id)).toBe(false);
  });

  it('another App\'s member cannot read this App\'s team space', async () => {
    // The tenant boundary the fix must not cross: admission is keyed on
    // Memory.appId, so it reaches only Apps the caller actually belongs to.
    const { shared } = await fixture();
    const outsider = await db.user.create({ data: { id: generateId(), name: 'outsider' } });
    const { app: otherApp } = await createDbAppWithKey(db, 'other-team', orgId);
    await createDbAppMember(db, otherApp.id, outsider.id, 'owner');

    const auth = memberAuth(outsider.id, otherApp.id);
    expect((await getMemoryAccess(db, auth)).has(shared.id)).toBe(false);
    expect(await canReadMemory(db, auth, shared.id)).toBe(false);
  });
});
