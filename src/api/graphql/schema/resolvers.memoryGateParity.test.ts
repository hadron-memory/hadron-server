/**
 * #1092 — the four surfaces that answer "may this principal read this memory"
 * must agree, PER PRINCIPAL SHAPE.
 *
 * Three instances of one drift landed in three months (#982 `Query.memory`,
 * #1070 `appNodes`, and this one), each found by a person tripping over it
 * rather than by a check. Each fix taught one predicate about one principal and
 * left the neighbours behind, because nothing asserted the predicates agree.
 * That is what this file is: a table over PRINCIPAL SHAPES × MEMORY KINDS,
 * asserting the record gate, the node-enumeration gate and the MCP point read
 * give the same answer. Adding a shape to one predicate and not the others reds
 * it here rather than three months later in a bug report.
 *
 * The expected answers are not this file's invention — they are
 * `cor:acl:010:01`'s per-class table and its four app-class row roles, which
 * state the team space's audience as App PARTICIPATION and say nothing about
 * enumeration being narrower.
 *
 * ONE PRINCIPAL SHAPE IS DELIBERATELY ABSENT, and saying so is the point of this
 * paragraph — a table that claims to cover principal shapes must not omit one
 * silently. A **MemoryShare grantee** is not here, because the two gates
 * genuinely disagree for them and the disagreement is somebody else's, filed as
 * **#849**: MCP's `canReadMemory` strict-owner branch tests `auth.userId !==
 * memory.userId` and NEVER consults `MemoryShare`, while the GraphQL side
 * honours shares through `granteeShareAccess` and `getAccessibleMemoryIds`'
 * `sharedWithMe` clause. Adding the row would red on the MCP column for a reason
 * this file is not the fix for. `resolvers.resolveUrn.test.ts` covers the
 * grantee against the two GraphQL gates (#1104); when #849 lands, that shape
 * belongs here.
 *
 * NOTE the deliberate asymmetry in what is asserted: the record gate is allowed
 * to be BROADER than node content (an org member may open an app-scoped
 * memory's record without reading its nodes — `findings:record-vs-node-content-memory-gate`),
 * so record is asserted against its own expectation rather than against the
 * node gate. What must never differ is the NODE-content answer between GraphQL
 * enumeration and the MCP point read: those two answer the identical question.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemoryRecord, getAccessibleMemoryIds } from './resolvers.helpers.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import type { AuthContext } from '../../../middleware/auth.js';

// ---------------------------------------------------------------------------
// Fixture — one App, one installed Agent, and one memory of each kind whose
// audience the parity question is actually about.
// ---------------------------------------------------------------------------

type Fixture = {
  orgId: string;
  appId: string;
  /** The installed agent's system memory — `cor:acl:010:01`: readable by anyone. */
  systemMemoryId: string;
  /** An org knowledge memory linked to the installed agent (an App memoryItem). */
  agentItemMemoryId: string;
  /** The App's team space — audience is App PARTICIPATION. */
  teamSpaceId: string;
  /** An ordinary org knowledge memory, reachable only by org membership. */
  orgOnlyMemoryId: string;
};

let fx: Fixture;

/** A user with no org role and no App membership — the outsider control. */
let strangerId: string;
/** AppMember at `member`, deliberately NO OrgMember row (the external/B2C shape). */
let externalMemberId: string;
/** OrgMember READER, deliberately NO AppMember row. */
let orgMemberId: string;

async function makeUser(githubId: number, handle: string): Promise<string> {
  const u = await db.user.create({
    data: { id: generateId(), githubId, githubUsername: `${handle}-${Date.now()}`, roles: ['READER'] },
  });
  return u.id;
}

beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: `parity-org-${Date.now()}` });

  const app = await db.app.create({
    data: { id: generateId(), name: 'parity-app', urn: `${org.id}:parity-app`, organizationId: org.id },
  });

  const systemMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.id}:parity-sys`,
      name: 'parity-sys',
      class: 'system',
    },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.id}:parity-agent`,
      name: 'parity agent',
      systemMemoryId: systemMemory.id,
    },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  // `graph` is the org knowledge memory the agent carries as a memoryItem.
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: graph.id, role: 'read' } });

  const teamSpace = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      appId: app.id,
      urn: `${org.id}:parity-team`,
      name: 'parity-team',
      class: 'app',
    },
  });

  const orgOnly = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.id}:parity-org-only`,
      name: 'parity-org-only',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });

  fx = {
    orgId: org.id,
    appId: app.id,
    systemMemoryId: systemMemory.id,
    agentItemMemoryId: graph.id,
    teamSpaceId: teamSpace.id,
    orgOnlyMemoryId: orgOnly.id,
  };

  strangerId = await makeUser(920001, 'parity-stranger');

  externalMemberId = await makeUser(920002, 'parity-external');
  await db.appMember.create({ data: { appId: app.id, userId: externalMemberId, role: 'member' } });

  orgMemberId = await makeUser(920003, 'parity-orgmember');
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: orgMemberId, role: 'READER' },
  });
});

// ---------------------------------------------------------------------------
// The three gates, asked the same question.
// ---------------------------------------------------------------------------

/** GraphQL RECORD gate — may they open the memory's scalars? */
async function recordGate(ctx: Context, memoryId: string): Promise<boolean> {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  return canReadMemoryRecord(ctx, memory);
}

/**
 * GraphQL NODE-CONTENT gate, scoped — the enumeration predicate behind
 * findNodes / memoryAccessFilter / the Edge endpoint check.
 */
async function enumerateGate(ctx: Context, memoryId: string): Promise<boolean> {
  const ids = await getAccessibleMemoryIds(ctx, memoryId);
  return ids === null || ids.includes(memoryId);
}

/** MCP NODE point read — the same question as `enumerateGate`, other surface. */
function mcpGate(auth: AuthContext, memoryId: string): Promise<boolean> {
  return canReadMemory(db as never, auth, memoryId);
}

describe('#1092 memory read gates agree per principal shape', () => {
  describe('external AppMember (AppMember row, NO org role — the B2C shape)', () => {
    const ctxOf = (): Context => ({ db, roles: ['READER'], userId: externalMemberId }) as Context;
    const authOf = (): AuthContext =>
      ({ userId: externalMemberId, roles: ['READER'] }) as AuthContext;

    it('reads the App team space through EVERY gate (cor:acl:010:01 — audience is participation)', async () => {
      expect(await recordGate(ctxOf(), fx.teamSpaceId)).toBe(true);
      expect(await mcpGate(authOf(), fx.teamSpaceId)).toBe(true);
      // The one that drifted: enumeration had no AppMember branch at all, so
      // findNodes scoped to the very memory `appNodes` just served returned
      // nothing, and Edge.source/target nulled its endpoints (#1093 Codex P2).
      expect(await enumerateGate(ctxOf(), fx.teamSpaceId)).toBe(true);
    });

    it('reads the installed agent memories through every gate', async () => {
      expect(await mcpGate(authOf(), fx.systemMemoryId)).toBe(true);
      expect(await enumerateGate(ctxOf(), fx.systemMemoryId)).toBe(true);
      expect(await mcpGate(authOf(), fx.agentItemMemoryId)).toBe(true);
      expect(await enumerateGate(ctxOf(), fx.agentItemMemoryId)).toBe(true);
    });

    it('does NOT reach an org memory the App does not carry — membership is of the App, not the org', async () => {
      expect(await mcpGate(authOf(), fx.orgOnlyMemoryId)).toBe(false);
      expect(await enumerateGate(ctxOf(), fx.orgOnlyMemoryId)).toBe(false);
      expect(await recordGate(ctxOf(), fx.orgOnlyMemoryId)).toBe(false);
    });
  });

  describe('org member with an ACTIVE APP SELECTION (the hybrid MCP shape)', () => {
    // hadron_find_nodes builds a GraphQL Context carrying BOTH userId and the
    // selected appId (mcp/server.ts), then delegates to Query.findNodes. So
    // this ctx shape is what every MCP search by a user who has selected an App
    // actually runs as — not a hypothetical.
    const ctxOf = (): Context =>
      ({ db, roles: ['READER'], userId: orgMemberId, appId: fx.appId }) as Context;
    const authOf = (): AuthContext =>
      ({ userId: orgMemberId, appId: fx.appId, roles: ['READER'] }) as AuthContext;

    it('keeps their ORG memories when an App is selected — selection focuses, it does not narrow', async () => {
      // cor:acl:020:01: App identity is a focusing concern, not access control.
      // The MCP gate unions the App fold with getOrgReadableMemoryIds; the
      // GraphQL gate returned early on ctx.appId and dropped the org half, so
      // selecting an App made a user's own org memories unfindable while
      // hadron_get_node on the same node still succeeded.
      expect(await mcpGate(authOf(), fx.orgOnlyMemoryId)).toBe(true);
      expect(await enumerateGate(ctxOf(), fx.orgOnlyMemoryId)).toBe(true);
    });

    it('still reaches the App fold', async () => {
      expect(await mcpGate(authOf(), fx.systemMemoryId)).toBe(true);
      expect(await enumerateGate(ctxOf(), fx.systemMemoryId)).toBe(true);
    });
  });

  describe('org member with no App selection', () => {
    const ctxOf = (): Context => ({ db, roles: ['READER'], userId: orgMemberId }) as Context;
    const authOf = (): AuthContext => ({ userId: orgMemberId, roles: ['READER'] }) as AuthContext;

    it('reaches their org memories through both node gates', async () => {
      expect(await mcpGate(authOf(), fx.orgOnlyMemoryId)).toBe(true);
      expect(await enumerateGate(ctxOf(), fx.orgOnlyMemoryId)).toBe(true);
    });

    it('does NOT reach the App team space — org membership is not App participation', async () => {
      // `cor:acl:010:01`: an App participant is an AppMember at any role, an org
      // CONTRIBUTOR+, or a user-owned App's owner. A READER is none of those, so
      // this asserts the gates stay CLOSED — the direction a widening breaks.
      expect(await mcpGate(authOf(), fx.teamSpaceId)).toBe(false);
      expect(await enumerateGate(ctxOf(), fx.teamSpaceId)).toBe(false);
    });
  });

  it('resolves BOTH endpoints of a cross-memory edge for an external AppMember (#1093 P2)', async () => {
    // The parity failure's user-visible face, and the test the issue asked for.
    // `appNodes` serves the external member nodes from BOTH memories, then
    // `Edge.source`/`Edge.target` re-authorize each endpoint through
    // `isMemoryReadableCached` → `getAccessibleMemoryIds`, which had no App arm
    // for this principal. Both endpoints came back NULL inside a response that
    // had just authorized them: the narrower predicate silently dropping data
    // the wider one admitted.
    const src = await db.node.create({
      data: { id: generateId(), memoryId: fx.teamSpaceId, loc: 'x:src', isLink: false, name: 'src', tags: [] },
    });
    const tgt = await db.node.create({
      data: { id: generateId(), memoryId: fx.agentItemMemoryId, loc: 'x:tgt', isLink: false, name: 'tgt', tags: [] },
    });
    const edge = await db.edge.create({
      data: {
        id: generateId(),
        memoryId: fx.teamSpaceId,
        loc: 'x:src:relation:x:tgt',
        sourceId: src.id,
        targetId: tgt.id,
        name: 'relation',
      },
    });

    const E = resolvers.Edge as unknown as {
      source: (e: unknown, a: unknown, c: Context) => Promise<{ id: string } | null>;
      target: (e: unknown, a: unknown, c: Context) => Promise<{ id: string } | null>;
    };
    const memberCtx = { db, roles: ['READER'], userId: externalMemberId } as Context;
    expect((await E.source(edge, {}, memberCtx))?.id).toBe(src.id);
    expect((await E.target(edge, {}, memberCtx))?.id).toBe(tgt.id);

    // …and the gate still CLOSES on the far side for someone outside the App:
    // the cross-memory endpoint check is doing its job, not switched off.
    const strangerCtx = { db, roles: ['READER'], userId: strangerId } as Context;
    expect(await E.target(edge, {}, strangerCtx)).toBeNull();
  });

  it('never lets the App fold carry a STRICT-OWNER row to an App member', async () => {
    // The MCP access map is documented personal-free, and `getAccessibleMemoryIds`
    // consumers rely on that: its output goes straight into `memoryId IN (...)`
    // with NO per-row personal re-check, unlike MCP's `canReadMemory`, which
    // strict-gates personal/private above the map. But nothing ENFORCES the
    // claim — `addMemoryToAgent` rejects only class `system`, so an org ADMIN
    // can attach a personal memory as an agent memory item and it folds in
    // (#1101 — the attach gate is the real fix; this is the read gate refusing
    // to depend on it).
    //
    // This pins the invariant at the surface that depends on it, because #1092
    // routes MORE principals through that fold: an assertion in a comment is not
    // a check, and the audience for this one just got wider.
    const owner = await makeUser(920004, 'parity-owner');
    const secret = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        userId: owner,
        urn: `${fx.orgId}:parity-secret`,
        name: 'parity-secret',
        class: 'personal',
      },
    });
    const agentId = (
      await db.appAgent.findFirstOrThrow({ where: { appId: fx.appId }, select: { agentId: true } })
    ).agentId;
    await db.agentMemoryItem.create({ data: { agentId, memoryId: secret.id, role: 'read' } });

    const memberCtx = { db, roles: ['READER'], userId: externalMemberId } as Context;
    const memberAuth = { userId: externalMemberId, roles: ['READER'] } as AuthContext;
    expect(await mcpGate(memberAuth, secret.id)).toBe(false);
    expect(await enumerateGate(memberCtx, secret.id)).toBe(false);
    expect(await recordGate(memberCtx, secret.id)).toBe(false);

    // The SAME hole, one branch over, and it predates #1092: a pure App KEY took
    // the App-fold early return, which had no strict-owner filter either. MCP
    // refuses this principal the same row (`canReadMemory`'s owner check denies
    // a credential with no userId), so the GraphQL gate was the wider of the
    // two — closed here rather than left because it sits three lines away and
    // is now proven constructible.
    const keyCtx = { db, appId: fx.appId } as Context;
    const keyAuth = { appId: fx.appId } as AuthContext;
    expect(await mcpGate(keyAuth, secret.id)).toBe(false);
    expect(await enumerateGate(keyCtx, secret.id)).toBe(false);
  });

  it('never lets the App fold carry a spec-047 USER-OWNED row to a co-member (PR #1102 review)', async () => {
    // @codex P1 + @copilot, and both were right. The first strict-owner filter
    // excluded only `personal`/`private` — but spec 047 adds a SECOND
    // owner-only axis, `ownerUserId`, on ordinary classes. `canWriteToMemory`
    // and `canReadMemory` both enforce it as a hard `auth.userId === ownerUserId`
    // with no ADMIN, org or App path; my enumeration filter did not, so the
    // parity this PR exists to create was broken again on the other axis.
    //
    // The reachable shape: `getPrimaryAgentAccess` excludes a user-owned row
    // only when its owner differs from the APP's owner — it has no callerUserId
    // check at all (unlike `getAppTeamSpaceAccess`, which grew one in #1004).
    // So a user-owned App's own owner's memories fold in for EVERY member.
    const appOwner = await makeUser(920005, 'parity-appowner');
    const coMember = await makeUser(920006, 'parity-comember');
    const ownedApp = await db.app.create({
      data: {
        id: generateId(),
        name: 'parity-owned-app',
        urn: `${appOwner}:parity-owned-app`,
        ownerUserId: appOwner,
      },
    });
    const ownedSystemMemory = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: appOwner,
        urn: `${appOwner}:parity-owned-sys`,
        name: 'parity-owned-sys',
        class: 'system',
      },
    });
    const ownedAgent = await db.agent.create({
      data: {
        id: generateId(),
        ownerUserId: appOwner,
        urn: `${appOwner}:parity-owned-agent`,
        name: 'owned agent',
        systemMemoryId: ownedSystemMemory.id,
      },
    });
    await db.appAgent.create({ data: { appId: ownedApp.id, agentId: ownedAgent.id } });
    await db.appMember.create({
      data: { appId: ownedApp.id, userId: coMember, role: 'member' },
    });

    const coCtx = { db, roles: ['READER'], userId: coMember } as Context;
    const coAuth = { userId: coMember, roles: ['READER'] } as AuthContext;
    expect(await mcpGate(coAuth, ownedSystemMemory.id)).toBe(false);
    expect(await enumerateGate(coCtx, ownedSystemMemory.id)).toBe(false);

    // …and the OWNER still reaches their own row, so the filter narrows to the
    // owner rather than to nobody. Without this the fix would pass by denying
    // everyone, which is not what spec 047 says.
    const ownerCtx = { db, roles: ['READER'], userId: appOwner } as Context;
    const ownerAuth = { userId: appOwner, roles: ['READER'] } as AuthContext;
    expect(await mcpGate(ownerAuth, ownedSystemMemory.id)).toBe(true);
    expect(await enumerateGate(ownerCtx, ownedSystemMemory.id)).toBe(true);
  });

  it('does not bleed another App\'s app-scoped memory through a SHARED agent (#1097, PR #1102 review)', async () => {
    // @copilot's second-round finding, and the sharper half is WHY it is mine:
    // the bleed is pre-existing in `getAppMemoryAccess` (an Agent's `memoryItems`
    // are global, so an Agent installed in A and B carries both Apps' app-scoped
    // rows), and #1070 explicitly left it filed as #1097 rather than fixed. But
    // this PR gives that fold a NEW audience — a plain user principal, who
    // previously got no App fold at all — so it would have widened a known leak
    // while claiming to close a drift.
    //
    // `appNodes` filters this downstream (resolvers.query.node.ts, "THIS App's
    // memories only"). Filtering it in the SHARED predicate instead keeps both
    // gates identical, which is this PR's entire thesis: fixing the bleed in
    // GraphQL alone would have re-created a parity break in the act of closing
    // one.
    const otherApp = await db.app.create({
      data: {
        id: generateId(),
        name: 'parity-other-app',
        urn: `${fx.orgId}:parity-other-app`,
        organizationId: fx.orgId,
      },
    });
    // App-INTERNAL memory of the FIRST App (#653: an app-scoped knowledge row is
    // reachable only through its own App's surface, never org-wide).
    const appAInternal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        appId: fx.appId,
        urn: `${fx.orgId}:parity-a-internal`,
        name: 'parity-a-internal',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    const sharedAgentId = (
      await db.appAgent.findFirstOrThrow({ where: { appId: fx.appId }, select: { agentId: true } })
    ).agentId;
    await db.agentMemoryItem.create({
      data: { agentId: sharedAgentId, memoryId: appAInternal.id, role: 'read' },
    });
    // The SAME agent installed into the second App — the whole mechanism.
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: sharedAgentId } });

    const bOnlyMember = await makeUser(920007, 'parity-b-only');
    await db.appMember.create({
      data: { appId: otherApp.id, userId: bOnlyMember, role: 'member' },
    });

    const bCtx = { db, roles: ['READER'], userId: bOnlyMember } as Context;
    const bAuth = { userId: bOnlyMember, roles: ['READER'] } as AuthContext;
    expect(await mcpGate(bAuth, appAInternal.id)).toBe(false);
    expect(await enumerateGate(bCtx, appAInternal.id)).toBe(false);

    // A member of App A still reaches it — the scope rule narrows to the App
    // whose fold is being built, not to nothing.
    const aCtx = { db, roles: ['READER'], userId: externalMemberId } as Context;
    const aAuth = { userId: externalMemberId, roles: ['READER'] } as AuthContext;
    expect(await mcpGate(aAuth, appAInternal.id)).toBe(true);
    expect(await enumerateGate(aCtx, appAInternal.id)).toBe(true);

    // And a non-app-scoped memoryItem (appId NULL — an ordinary org knowledge
    // memory the agent carries) stays reachable from BOTH Apps: the filter is
    // about app-scoped rows, not about memoryItems in general.
    expect(await enumerateGate(bCtx, fx.agentItemMemoryId)).toBe(true);
  });

  describe('stranger (no org role, no App membership)', () => {
    const ctxOf = (): Context => ({ db, roles: ['READER'], userId: strangerId }) as Context;
    const authOf = (): AuthContext => ({ userId: strangerId, roles: ['READER'] }) as AuthContext;

    it('reaches nothing in this org through any gate', async () => {
      for (const id of [fx.teamSpaceId, fx.agentItemMemoryId, fx.orgOnlyMemoryId]) {
        expect(await mcpGate(authOf(), id)).toBe(false);
        expect(await enumerateGate(ctxOf(), id)).toBe(false);
        expect(await recordGate(ctxOf(), id)).toBe(false);
      }
    });
  });
});
