/**
 * #1196 — the App-derived fold must implement PARTICIPATION, not the AppMember
 * table.
 *
 * `cor:acl:010:01` states the team space's audience as participation — "an App
 * member at any role, an org CONTRIBUTOR+ on the App's org, or the owner of a
 * user-owned App" — and names "re-keying the team space's audience off
 * participation (e.g. onto the member table alone)" as invalidating. Both arms
 * of `getPrincipalAppMemoryAccess` reached Apps through `resolveUserApps`,
 * which is `appMember.findMany` and nothing else, so the org-CONTRIBUTOR and
 * user-owned-App-owner arms were missing.
 *
 * The measurement that opened this, on unmodified `main`:
 *
 *     CONTRIBUTOR  isAppParticipant=true   inAccessibleSet=false
 *     APP MEMBER   isAppParticipant=true   inAccessibleSet=true
 *
 * That divergence is what made #1196's unification dangerous in the obvious
 * direction: routing the chat surfaces through `getAccessibleMemoryIds` as it
 * stood would have SILENTLY NARROWED the team chat for every org CONTRIBUTOR
 * who is not an AppMember. The chat gate was right; this one had drifted.
 *
 * What these tests pin, beyond the fix itself, is its NARROWNESS — the
 * one-line version of this change (widen the App list) passes the first test
 * and fails `the agent-derived half is NOT widened`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import {
  cleanDb,
  createDbAppWithKey,
  createDbAppAgent,
  createDbAppMember,
} from '../test/helpers.js';
import { getMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { participantAppIds } from '../lib/auth/appParticipation.js';
import {
  getAccessibleMemoryIds,
  isAppParticipant,
  type Context,
} from '../api/graphql/schema/resolvers.helpers.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

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
    data: { id: generateId(), name: 'part-org', urn: 'part-org' },
  });
  orgId = org.id;
});

/**
 * An org-owned App with its Team Agent installed, its app-class TEAM SPACE, and
 * an AGENT-DERIVED memory attached to that agent at `read-write` — the row whose
 * audience is NOT participation, and which a too-wide fix hands over.
 */
async function fixture() {
  const agent = await db.agent.create({
    data: { id: generateId(), name: 'Team Agent', urn: `${orgId}:team-agent`, organizationId: orgId },
  });
  const { app } = await createDbAppWithKey(db, 'eng-team', orgId);
  await createDbAppAgent(db, app.id, agent.id);

  const teamSpace = await db.memory.create({
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

  // Agent-derived, app-agnostic (`appId: null`), attached read-write. The
  // install's granted role is what decides this row's level — a different
  // audience from the team space's.
  const agentMemory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      name: 'agent-notes',
      urn: `${orgId}:agent-notes`,
      organizationId: orgId,
      // knowledge takes PUBLIC or ORGANIZATION; GROUP belongs to the `group`
      // class (chk_memory_group_visibility).
      visibility: 'ORGANIZATION' as never,
    },
  });
  await db.agentMemoryItem.create({
    data: { id: generateId(), agentId: agent.id, memoryId: agentMemory.id, role: 'read-write' },
  });

  return { app, agent, teamSpace, agentMemory };
}

async function makeOrgUser(name: string, role: 'READER' | 'CONTRIBUTOR' | 'ADMIN' | 'OWNER') {
  const user = await db.user.create({ data: { id: generateId(), name } });
  await db.orgMember.create({
    data: { organizationId: orgId, userId: user.id, role: role as never },
  });
  return user;
}

const userCtx = (userId: string, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: [], ...extra }) as unknown as Context;

const userAuth = (userId: string): AuthContext =>
  ({ userId, roles: [], clientId: `user:${userId}` }) as AuthContext;

/** Is `memoryId` in the caller's accessible set? (`null` = unrestricted.) */
async function inAccessibleSet(ctx: Context, memoryId: string): Promise<boolean> {
  const ids = await getAccessibleMemoryIds(ctx, memoryId);
  return ids === null || ids.includes(memoryId);
}

describe('#1196 — the App fold implements participation, not the member table', () => {
  it('an org CONTRIBUTOR who is NOT an AppMember reaches the team space', async () => {
    const { app, teamSpace } = await fixture();
    const contributor = await makeOrgUser('org-contributor', 'CONTRIBUTOR');
    const ctx = userCtx(contributor.id);
    const appRow = await db.app.findUniqueOrThrow({ where: { id: app.id } });

    // Both halves of the divergence, asserted together so a regression in
    // either direction names itself.
    expect(await isAppParticipant(ctx, appRow)).toBe(true);
    expect(await inAccessibleSet(ctx, teamSpace.id)).toBe(true);

    // And over MCP, which consumes the same fold.
    expect((await getMemoryAccess(db, userAuth(contributor.id))).get(teamSpace.id)).toBe('READ_ONLY');
  });

  it('the agent-derived half is NOT widened — participation buys the team space only', async () => {
    // The one-line version of this fix — widening `resolveUserApps` to
    // participant Apps — passes the test above and fails here: it would fold
    // `getAppMemoryAccess`, handing an org CONTRIBUTOR who installed nothing
    // READ_WRITE on the Agent's attached memory.
    const { agentMemory } = await fixture();
    const contributor = await makeOrgUser('org-contributor', 'CONTRIBUTOR');

    const fold = await getPrincipalAppMemoryAccess(db, { userId: contributor.id });
    expect(fold.has(agentMemory.id)).toBe(false);

    // Nothing the participation fold contributes is ever writable.
    expect([...fold.values()].every((level) => level === 'READ_ONLY')).toBe(true);
  });

  it('an org READER does NOT reach it — the threshold is CONTRIBUTOR', async () => {
    const { app, teamSpace } = await fixture();
    const reader = await makeOrgUser('org-reader', 'READER');
    const ctx = userCtx(reader.id);
    const appRow = await db.app.findUniqueOrThrow({ where: { id: app.id } });

    expect(await isAppParticipant(ctx, appRow)).toBe(false);
    expect(await inAccessibleSet(ctx, teamSpace.id)).toBe(false);
  });

  it('a REVOKED org membership does not authorize', async () => {
    // findings:revoked-membership-auth-gates — org revocation is a soft delete,
    // so the fold must filter `deletedAt: null` rather than findUnique the
    // composite PK.
    const { teamSpace } = await fixture();
    const contributor = await makeOrgUser('org-contributor', 'CONTRIBUTOR');
    await db.orgMember.updateMany({
      where: { organizationId: orgId, userId: contributor.id },
      data: { deletedAt: new Date() },
    });

    expect(await inAccessibleSet(userCtx(contributor.id), teamSpace.id)).toBe(false);
  });

  it('a deleted organization revokes both contributor and AppMember participation', async () => {
    const { app, teamSpace } = await fixture();
    const contributor = await makeOrgUser('deleted-org-contributor', 'CONTRIBUTOR');
    const member = await db.user.create({ data: { id: generateId(), name: 'deleted-org-member' } });
    await createDbAppMember(db, app.id, member.id, 'reader');
    const appRow = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    for (const principal of [contributor, member]) {
      expect(await isAppParticipant(userCtx(principal.id), appRow)).toBe(true);
      expect((await participantAppIds(db, { userId: principal.id }, { includeMemberships: true }))).toContain(app.id);
      expect((await getPrincipalAppMemoryAccess(db, { userId: principal.id })).has(teamSpace.id)).toBe(true);
    }

    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    for (const principal of [contributor, member]) {
      expect(await isAppParticipant(userCtx(principal.id), appRow)).toBe(false);
      expect((await participantAppIds(db, { userId: principal.id }, { includeMemberships: true }))).not.toContain(app.id);
      expect((await getPrincipalAppMemoryAccess(db, { userId: principal.id })).has(teamSpace.id)).toBe(false);
      expect((await getMemoryAccess(db, userAuth(principal.id))).has(teamSpace.id)).toBe(false);
    }
  });

  it('an org CONTRIBUTOR of ANOTHER org does not reach it', async () => {
    const { teamSpace } = await fixture();
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    const outsider = await db.user.create({ data: { id: generateId(), name: 'outsider' } });
    await db.orgMember.create({
      data: { organizationId: otherOrg.id, userId: outsider.id, role: 'CONTRIBUTOR' as never },
    });

    expect(await inAccessibleSet(userCtx(outsider.id), teamSpace.id)).toBe(false);
  });

  it('an UNINSTALLED App\'s team space is not folded', async () => {
    const { app, teamSpace } = await fixture();
    const contributor = await makeOrgUser('org-contributor', 'CONTRIBUTOR');
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });

    expect(await inAccessibleSet(userCtx(contributor.id), teamSpace.id)).toBe(false);
  });

  it('a session-isolated App-key principal is unchanged — no participation to derive', async () => {
    // The shape the team space must never reach (#1003 Codex P1 / #934). It has
    // no userId, which is what keeps it out of the new fold by construction.
    const { app, teamSpace } = await fixture();
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, type: 'CHATBOT' as never },
    });

    const fold = await getPrincipalAppMemoryAccess(db, { appId: app.id, sessionId: session.id });
    expect(fold.has(teamSpace.id)).toBe(false);
  });

  describe('impersonation stays bounded (#876 class)', () => {
    it('the org arm is bounded to the support session\'s ONE shared org', async () => {
      // `ctx.userId` is the TARGET, so an unbounded arm would answer a question
      // about the target's memberships anywhere. The App here lives in `orgId`;
      // the support session is scoped to a different org.
      const { teamSpace } = await fixture();
      const target = await makeOrgUser('target', 'CONTRIBUTOR');
      const otherOrg = await db.organization.create({
        data: { id: generateId(), name: 'support-org', urn: 'support-org' },
      });

      const impersonated = userCtx(target.id, {
        impersonation: { orgId: otherOrg.id },
      } as Partial<Context>);
      expect(await inAccessibleSet(impersonated, teamSpace.id)).toBe(false);

      // And the fold itself, so the bound is pinned where it is implemented
      // rather than only where an earlier branch happens to short-circuit.
      const fold = await getPrincipalAppMemoryAccess(db, {
        userId: target.id,
        impersonation: { orgId: otherOrg.id },
      });
      expect(fold.has(teamSpace.id)).toBe(false);
    });

    it('the user-owned-App owner arm is denied outright', async () => {
      // Identity-scoped, so never via impersonation — the same rule
      // `isAppParticipant` applies to its owner arm.
      const owner = await db.user.create({ data: { id: generateId(), name: 'app-owner' } });
      const app = await db.app.create({
        data: { id: generateId(), name: 'solo', urn: `u-${owner.id}:solo`, ownerUserId: owner.id },
      });
      const teamSpace = await db.memory.create({
        data: {
          class: 'app',
          id: generateId(),
          name: 'solo-shared',
          urn: `u-${owner.id}:solo-shared`,
          ownerUserId: owner.id,
          appId: app.id,
        },
      });

      expect(
        (await getPrincipalAppMemoryAccess(db, { userId: owner.id })).has(teamSpace.id),
      ).toBe(true);
      expect(
        (
          await getPrincipalAppMemoryAccess(db, {
            userId: owner.id,
            impersonation: { orgId },
          })
        ).has(teamSpace.id),
      ).toBe(false);
    });
  });

  it('DIFFERENTIAL: the fold and isAppParticipant agree on every org role', async () => {
    // cor:agt:020:11's rule applied to this pair — the team-chat gate and the
    // memory gate must be ONE computation, and #1196 exists because they were
    // not. Scoped to NON-platform-admin principals on purpose: a platform admin
    // passes `isAppParticipant` through `requireOrgRole`'s bypass and is
    // answered by `getAccessibleMemoryIds`'s own admin branch ABOVE the fold, so
    // the fold deliberately has no admin arm and the two would disagree here for
    // a reason that is not drift.
    const { app, teamSpace } = await fixture();
    const appRow = await db.app.findUniqueOrThrow({ where: { id: app.id } });

    const cases: Array<['READER' | 'CONTRIBUTOR' | 'ADMIN' | 'OWNER', string]> = [
      ['READER', 'org-reader'],
      ['CONTRIBUTOR', 'org-contributor'],
      ['ADMIN', 'org-admin'],
      ['OWNER', 'org-owner'],
    ];
    for (const [role, name] of cases) {
      const user = await makeOrgUser(name, role);
      const ctx = userCtx(user.id);
      expect({ role, reaches: await inAccessibleSet(ctx, teamSpace.id) }).toEqual({
        role,
        reaches: await isAppParticipant(ctx, appRow),
      });
    }

    // And the AppMember arm, which needs no org role at all.
    const external = await db.user.create({ data: { id: generateId(), name: 'external-member' } });
    await createDbAppMember(db, app.id, external.id, 'reader');
    const ctx = userCtx(external.id);
    expect(await inAccessibleSet(ctx, teamSpace.id)).toBe(await isAppParticipant(ctx, appRow));
  });

  it('DIFFERENTIAL: the SET form agrees with isAppParticipant on a USER-OWNED App', async () => {
    // The shape that caught round 4 (@copilot), and the one the differential
    // above could not see: `isAppParticipant` returns IMMEDIATELY for
    // `ownerUserId !== null` and admits only the owner, while
    // `participantAppIds`' membership arm admitted any AppMember of one. Two
    // spellings of one audience disagreeing on exactly the shape spec 047 is
    // strictest about — and reachable, since `chatLocFilter` requests that arm
    // and `sendChatMessage` uses the filter as its write entitlement.
    const owner = await db.user.create({ data: { id: generateId(), name: 'solo-owner' } });
    const joiner = await db.user.create({ data: { id: generateId(), name: 'solo-joiner' } });
    const solo = await db.app.create({
      data: { id: generateId(), name: 'solo', urn: `u-${owner.id}:solo`, ownerUserId: owner.id },
    });
    await createDbAppMember(db, solo.id, joiner.id, 'admin');
    const soloRow = await db.app.findUniqueOrThrow({ where: { id: solo.id } });

    for (const [who, user] of [['owner', owner], ['joiner', joiner]] as const) {
      const ctx = userCtx(user.id);
      const inSet = (await participantAppIds(db, { userId: user.id }, { includeMemberships: true })).includes(solo.id);
      expect({ who, inSet }).toEqual({ who, inSet: await isAppParticipant(ctx, soloRow) });
    }
  });
});
