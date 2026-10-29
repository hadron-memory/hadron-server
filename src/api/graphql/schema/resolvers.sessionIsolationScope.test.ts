/**
 * #945 — the App-key-with-session isolation branch must NARROW, never GRANT.
 *
 * The branch confines an App key operating inside a session to that session's
 * memory plus the bound agent's system memory. It was written when
 * `startAgentSession` was the only writer of `Session.memoryId`/`agentId`, so
 * the App had authored both and the row could be trusted. `SessionInput.agentRef`
 * (#928) and `SessionInput.appRef` (#943) made both pivots caller-suppliable,
 * which turns an unguarded branch into a grant.
 *
 * The live case is the agent leg: `agentRef` gates only on the agent being
 * READABLE, so a member can bind a foreign PUBLIC agent to a session of their
 * own App — and before this fix the App's key could then read that agent's
 * system memory (its prompt and role definitions).
 *
 * Both surfaces that implement the confinement now share one predicate, so the
 * parity test at the bottom is the guard against them re-diverging.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant, createDbAgentSubscription } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { getAccessibleMemoryIds, type Context } from './resolvers.helpers.js';
import { sessionScopedMemoryIds } from '../../../lib/auth/sessionScopedMemoryIds.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

/** An App-key principal operating inside a session (no userId — a credential). */
const appKeyCtx = (appId: string, sessionId: string): Context =>
  ({ db, appId, sessionId, roles: [] }) as Context;

let org: { id: string; urn: string };
let foreignOrg: { id: string; urn: string };
let app: { id: string };
let ownAgent: { id: string; systemMemoryId: string };
let foreignAgent: { id: string; systemMemoryId: string };
let user: { id: string };

/** Create an agent with its own system memory, in `orgId`. */
async function makeAgent(orgId: string, orgUrn: string, slug: string, visibility: string) {
  const systemMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `${orgUrn}:${slug}-sys`,
      name: `${slug} system`,
      class: 'system',
    },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `${orgUrn}:${slug}`,
      name: slug,
      systemMemoryId: systemMemory.id,
      visibility: visibility as any,
    },
  });
  return { id: agent.id, systemMemoryId: systemMemory.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'sis-org', urn: `sis-org-${suffix}.com` },
  });
  foreignOrg = await db.organization.create({
    data: { id: generateId(), name: 'sis-foreign', urn: `sis-foreign-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 94501, githubUsername: `sis-user-${suffix}`, roles: ['READER'] },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` },
  });
  ownAgent = await makeAgent(org.id, org.urn, 'own', 'ORGANIZATION');
  await db.appAgent.create({ data: { appId: app.id, agentId: ownAgent.id } });
  // Another tenant's PUBLIC agent — readable, so `agentRef` accepts it, but
  // NOT installed in our App.
  foreignAgent = await makeAgent(foreignOrg.id, foreignOrg.urn, 'foreign', 'PUBLIC');
});

/** The per-user memory startAgentSession provisions: appId + userMemoryOfAgentId. */
async function provisionedMemory(agentId: string, appId: string | null, ownerUserId?: string) {
  return db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:${generateId().slice(-10)}`,
      name: 'user memory',
      class: 'personal',
      userId: ownerUserId ?? user.id,
      userMemoryOfAgentId: agentId,
      appId,
    },
  });
}

describe('#945 — the agent leg rides on the INSTALL, not the binding', () => {
  it('excludes a foreign PUBLIC agent\'s system memory (the live escalation)', async () => {
    // A member stamps their own session with their App (#943 appRef) and binds
    // it to another tenant's PUBLIC agent (#928 agentRef — readable, so allowed).
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: foreignAgent.id },
    });
    const ids = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    expect(ids).not.toContain(foreignAgent.systemMemoryId);
    expect(ids).toEqual([]);
  });

  it('still includes the system memory of an agent installed in this App', async () => {
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id },
    });
    const ids = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    expect(ids).toContain(ownAgent.systemMemoryId);
  });

  it('drops the system memory as soon as the agent is uninstalled', async () => {
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toContain(
      ownAgent.systemMemoryId,
    );
    await db.appAgent.delete({
      where: { appId_agentId: { appId: app.id, agentId: ownAgent.id } },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).not.toContain(
      ownAgent.systemMemoryId,
    );
  });

  it('drops the whole session scope when its App is uninstalled', async () => {
    await createDbAgentSubscription(db, user.id, ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    expect(new Set(await sessionScopedMemoryIds(db, app.id, session.id))).toEqual(
      new Set([mem.id, ownAgent.systemMemoryId]),
    );
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect(await sessionScopedMemoryIds(db, app.id, session.id)).toEqual([]);
  });

  it('drops the whole session scope when its organization is soft-deleted', async () => {
    await createDbAgentSubscription(db, user.id, ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    expect(new Set(await sessionScopedMemoryIds(db, app.id, session.id))).toEqual(
      new Set([mem.id, ownAgent.systemMemoryId]),
    );
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await sessionScopedMemoryIds(db, app.id, session.id)).toEqual([]);
  });
});

describe('#945 — the memory leg must be tied to this App or this session\'s agent', () => {
  it('admits a memory this App provisioned (the startAgentSession shape)', async () => {
    await createDbAgentSubscription(db, user.id, ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    const ids = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    expect(new Set(ids)).toEqual(new Set([mem.id, ownAgent.systemMemoryId]));
  });

  it('admits the reuse case — another App provisioned the (agent, user) memory', async () => {
    // startAgentSession reuses an existing per-user memory keyed on
    // (agent, user), so its appId can name a DIFFERENT App that installed the
    // same agent. That must keep working.
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` },
    });
    await createDbAgentSubscription(db, user.id, ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, otherApp.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toContain(mem.id);
  });

  it('excludes a memory tied to neither this App nor this session\'s agent', async () => {
    // No caller path writes Session.memoryId today (#946 decided to keep it
    // App-provisioned), so this pins the invariant against a FUTURE writer —
    // which is why the row is built directly rather than through a mutation.
    const strangerMem = await provisionedMemory(foreignAgent.id, null, user.id);
    const session = await db.session.create({
      data: {
        id: generateId(), appId: app.id, userId: user.id,
        agentId: ownAgent.id, memoryId: strangerMem.id,
      },
    });
    const ids = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    expect(ids).not.toContain(strangerMem.id);
    expect(ids).toEqual([ownAgent.systemMemoryId]);
  });

  it('does not treat a malformed AgentMemoryItem role as a session read grant', async () => {
    const memory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:invalid-link`,
        name: 'invalid link', class: 'knowledge',
      },
    });
    const link = await db.agentMemoryItem.create({
      data: { agentId: ownAgent.id, memoryId: memory.id, role: 'bogus' },
    });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: memory.id },
    });
    expect(await sessionScopedMemoryIds(db, app.id, session.id)).toEqual([ownAgent.systemMemoryId]);
    await db.agentMemoryItem.update({ where: { id: link.id }, data: { role: 'read' } });
    expect(new Set(await sessionScopedMemoryIds(db, app.id, session.id))).toEqual(
      new Set([memory.id, ownAgent.systemMemoryId]),
    );
  });

  it('does not turn an Agent link into an App-key grant on user-owned knowledge', async () => {
    const owner = await db.user.create({ data: { id: generateId(), name: 'knowledge owner' } });
    const owned = await db.memory.create({
      data: {
        id: generateId(), ownerUserId: owner.id,
        urn: `u-${owner.id}:linked-knowledge`, name: 'owner-only knowledge',
        class: 'knowledge', visibility: 'PUBLIC',
      },
    });
    const shared = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id,
        urn: `${org.urn}:linked-knowledge`, name: 'org knowledge', class: 'knowledge',
      },
    });
    await db.agentMemoryItem.createMany({ data: [
      { agentId: ownAgent.id, memoryId: owned.id, role: 'read' },
      { agentId: ownAgent.id, memoryId: shared.id, role: 'read' },
    ] });
    for (const [memoryId, allowed] of [[owned.id, false], [shared.id, true]] as const) {
      const session = await db.session.create({
        data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId },
      });
      const ids = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
      expect(ids).not.toBeNull();
      expect(ids!.includes(memoryId)).toBe(allowed);
    }
  });

  it('does not import another App’s linked knowledge or agent-owned scratch memory', async () => {
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` },
    });
    const knowledge = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, appId: otherApp.id,
        urn: `${org.urn}:other-knowledge`, name: 'other knowledge', class: 'knowledge',
      },
    });
    await db.agentMemoryItem.create({
      data: { agentId: ownAgent.id, memoryId: knowledge.id, role: 'read' },
    });
    const scratch = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, appId: otherApp.id,
        urn: `${org.urn}:other-scratch`, name: 'other scratch', class: 'app',
        userMemoryOfAgentId: ownAgent.id,
      },
    });
    for (const memoryId of [knowledge.id, scratch.id]) {
      const session = await db.session.create({
        data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId },
      });
      expect(await sessionScopedMemoryIds(db, app.id, session.id)).toEqual([ownAgent.systemMemoryId]);
    }
  });

  it('keeps the onlyMemoryId scoping honest for an inadmissible target', async () => {
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: foreignAgent.id },
    });
    expect(
      await getAccessibleMemoryIds(appKeyCtx(app.id, session.id), foreignAgent.systemMemoryId),
    ).toEqual([]);
  });
});

describe('#945 review — lifecycle, not just structure', () => {
  /** Subscribe `user` to `agentId` so a personal session memory is licensed
   *  (what `startAgentSession` does via `ensureAgentSubscription`). */
  const subscribe = (agentId: string) => createDbAgentSubscription(db, user.id, agentId);

  it('requires a personal App owner’s live AgentSubscription for a foreign Agent system memory', async () => {
    const personalApp = await db.app.create({
      data: { id: generateId(), name: 'Personal', urn: `@${user.id}:personal`, ownerUserId: user.id },
    });
    await db.appAgent.create({ data: { appId: personalApp.id, agentId: foreignAgent.id } });
    await createDbAgentSubscription(db, user.id, foreignAgent.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: personalApp.id, userId: user.id, agentId: foreignAgent.id },
    });
    expect(await sessionScopedMemoryIds(db, personalApp.id, session.id)).toContain(foreignAgent.systemMemoryId);
    await db.agentSubscription.update({
      where: { userId_agentId: { userId: user.id, agentId: foreignAgent.id } },
      data: { revokedAt: new Date() },
    });
    expect(await sessionScopedMemoryIds(db, personalApp.id, session.id)).not.toContain(foreignAgent.systemMemoryId);
  });

  it('requires the creator and active subscription for a legacy knowledge holding', async () => {
    const holding = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:legacy-holding`,
        name: 'legacy holding', class: 'knowledge', visibility: 'PUBLIC',
        userMemoryOfAgentId: ownAgent.id, createdBy: user.id,
      },
    });
    const outsider = await db.user.create({ data: { id: generateId(), name: 'Outsider' } });
    const outsiderSession = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: outsider.id, agentId: ownAgent.id, memoryId: holding.id },
    });
    expect(await sessionScopedMemoryIds(db, app.id, outsiderSession.id)).not.toContain(holding.id);

    await subscribe(ownAgent.id);
    const ownerSession = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: holding.id },
    });
    expect(await sessionScopedMemoryIds(db, app.id, ownerSession.id)).toContain(holding.id);
    await db.agentSubscription.update({
      where: { userId_agentId: { userId: user.id, agentId: ownAgent.id } },
      data: { revokedAt: new Date() },
    });
    expect(await sessionScopedMemoryIds(db, app.id, ownerSession.id)).not.toContain(holding.id);
  });

  it('drops the system memory when a cross-org install\'s AgentOrgGrant is revoked (Codex P1)', async () => {
    // The foreign agent is installed cross-org under an ACTIVE grant, so its
    // system memory is legitimately in scope...
    await db.appAgent.create({ data: { appId: app.id, agentId: foreignAgent.id } });
    await createDbAgentOrgGrant(db, org.id, foreignAgent.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: foreignAgent.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toContain(
      foreignAgent.systemMemoryId,
    );

    // ...and out of scope the moment the grant is revoked. The AppAgent join
    // row survives revocation, so `isAgentInstalled` alone would still say yes
    // (getAppMemoryAccess collapses to empty here — 008-multi-install-isolation).
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: org.id, agentId: foreignAgent.id } },
      data: { revokedAt: new Date() },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).not.toContain(
      foreignAgent.systemMemoryId,
    );
  });

  it('drops linked knowledge with the same revoked cross-org install license', async () => {
    await db.appAgent.create({ data: { appId: app.id, agentId: foreignAgent.id } });
    await createDbAgentOrgGrant(db, org.id, foreignAgent.id);
    const knowledge = await db.memory.create({
      data: {
        id: generateId(), organizationId: foreignOrg.id,
        urn: `${foreignOrg.urn}:licensed-knowledge`, name: 'licensed knowledge',
        class: 'knowledge', visibility: 'PUBLIC',
      },
    });
    await db.agentMemoryItem.create({
      data: { agentId: foreignAgent.id, memoryId: knowledge.id, role: 'read' },
    });
    const session = await db.session.create({
      data: {
        id: generateId(), appId: app.id, userId: user.id,
        agentId: foreignAgent.id, memoryId: knowledge.id,
      },
    });
    const reachable = () => getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    expect(await reachable()).toContain(knowledge.id);
    expect(await reachable()).toContain(foreignAgent.systemMemoryId);

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: org.id, agentId: foreignAgent.id } },
      data: { revokedAt: new Date() },
    });
    expect(await reachable()).not.toContain(knowledge.id);
    expect(await reachable()).not.toContain(foreignAgent.systemMemoryId);
  });

  it('a same-org install needs no grant row (the auto-pass path)', async () => {
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toContain(
      ownAgent.systemMemoryId,
    );
  });

  it('drops a soft-deleted memory and a soft-deleted agent (Copilot)', async () => {
    await subscribe(ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    expect(new Set(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id)))).toEqual(
      new Set([mem.id, ownAgent.systemMemoryId]),
    );

    // deleteMemory stamps only the Memory row; the session keeps pointing at it.
    await db.memory.update({ where: { id: mem.id }, data: { deletedAt: new Date() } });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toEqual([
      ownAgent.systemMemoryId,
    ]);

    // deleteAgent soft-deletes the Agent and leaves Session/AppAgent behind.
    await db.agent.update({ where: { id: ownAgent.id }, data: { deletedAt: new Date() } });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toEqual([]);
  });

  it('requires an active AgentSubscription for a personal session memory (Copilot)', async () => {
    await subscribe(ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toContain(mem.id);

    // Revocation does not end the session or empty the memory, so without this
    // the branch would be the one place a de-licensed pair still reads.
    await db.agentSubscription.update({
      where: { userId_agentId: { userId: user.id, agentId: ownAgent.id } },
      data: { revokedAt: new Date() },
    });
    const after = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    expect(after).not.toContain(mem.id);
    expect(after).toEqual([ownAgent.systemMemoryId]);
  });

  it('refuses a personal memory owned by someone other than the session driver', async () => {
    const other = await db.user.create({
      data: { id: generateId(), githubId: 94502, githubUsername: `sis-other-${generateId().slice(-6)}`, roles: ['READER'] },
    });
    await createDbAgentSubscription(db, other.id, ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id, other.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).not.toContain(mem.id);
  });

  it('leaves non-personal session memories alone (anonymous scratch + knowledge)', async () => {
    // The anonymous 'app'-class scratch memory carries no per-user license.
    const scratch = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:anon-${generateId().slice(-8)}`,
        name: 'anon', class: 'app', userMemoryOfAgentId: ownAgent.id, appId: app.id,
      },
    });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId: ownAgent.id, memoryId: scratch.id },
    });
    expect(await getAccessibleMemoryIds(appKeyCtx(app.id, session.id))).toContain(scratch.id);
  });
});

describe('#945 — the two surfaces share one predicate', () => {
  it('the resolver gate returns exactly what the shared predicate returns', async () => {
    // The MCP node-search scope (src/mcp/server.ts) calls the same function, so
    // pinning the resolver to it pins both. A hand-copied second branch is what
    // this test exists to prevent (findings:public-read-predicate-has-two-copies).
    await createDbAgentSubscription(db, user.id, ownAgent.id);
    const mem = await provisionedMemory(ownAgent.id, app.id);
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: mem.id },
    });
    const viaResolver = await getAccessibleMemoryIds(appKeyCtx(app.id, session.id));
    const viaPredicate = await sessionScopedMemoryIds(db, app.id, session.id);
    expect(new Set(viaResolver)).toEqual(new Set(viaPredicate));
  });

  it('returns an empty scope for a session that no longer exists', async () => {
    expect(await sessionScopedMemoryIds(db, app.id, generateId())).toEqual([]);
  });
});

describe("#934 — a user principal's session binding never changes their scope", () => {
  // User principals can now carry `ctx.sessionId` (the X-Hadron-Session
  // heartbeat binding, amending cor:aut:020:02). The session-scope branch
  // above is the PURE App-key boundary: a hybrid user+selection principal
  // entering it would swap their reach for `sessionScopedMemoryIds`, which
  // never consults the USER's rights — a narrowing at best, a grant at
  // worst. This is the #967 narrow-never-grant rule, mirrored for users.
  //
  // Note the hybrid shape's reach is the App-SELECTION reach (the
  // `ctx.appId` branch) with or without a binding — pre-existing design,
  // not this change. What #934 pins is that the BINDING is inert for scope.

  /** The hybrid MCP shape: a user credential plus an active-App selection. */
  const hybridCtx = (userId: string, appId: string, sessionId?: string): Context =>
    ({ db, userId, appId, sessionId, roles: ['READER'] }) as Context;

  /** The pure user shape: the self-attributed CLI/portal case (appId null). */
  const userCtx = (userId: string, sessionId?: string): Context =>
    ({ db, userId, sessionId, roles: ['READER'] }) as Context;

  it('pure user shape: reach with a bound session equals reach without one', async () => {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'READER' },
    });
    const knowledge = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:kn-${generateId().slice(-8)}`,
        name: 'kn', class: 'knowledge',
      },
    });
    const session = await db.session.create({
      data: { id: generateId(), userId: user.id, type: 'DEVELOPER' },
    });
    const unbound = await getAccessibleMemoryIds(userCtx(user.id));
    const bound = await getAccessibleMemoryIds(userCtx(user.id, session.id));
    expect(new Set(bound)).toEqual(new Set(unbound));
    expect(bound).toContain(knowledge.id);
  });

  it('hybrid shape: reach with a bound session equals reach without one', async () => {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'READER' },
    });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id },
    });
    const unbound = await getAccessibleMemoryIds(hybridCtx(user.id, app.id));
    const bound = await getAccessibleMemoryIds(hybridCtx(user.id, app.id, session.id));
    expect(new Set(bound)).toEqual(new Set(unbound));
  });

  it("hybrid shape: the binding does not grant the session's memory (what the App-key branch returns)", async () => {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'READER' },
    });
    // The anonymous app-class scratch memory: inside the App-key session
    // scope, OUTSIDE both the App's management reach and the user's org
    // reach — so it is a clean witness for the grant the guard prevents.
    const scratch = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:sc-${generateId().slice(-8)}`,
        name: 'scratch', class: 'app', userMemoryOfAgentId: ownAgent.id, appId: app.id,
      },
    });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id, agentId: ownAgent.id, memoryId: scratch.id },
    });
    // Sanity: the App-key session branch WOULD include it…
    expect(await sessionScopedMemoryIds(db, app.id, session.id)).toContain(scratch.id);
    // …and the bound hybrid principal must not.
    const bound = await getAccessibleMemoryIds(hybridCtx(user.id, app.id, session.id));
    expect(bound).not.toContain(scratch.id);
  });
});
