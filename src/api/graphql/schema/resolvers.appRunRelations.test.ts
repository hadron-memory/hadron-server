/**
 * #831 — AppRun relation fields (`app` / `agent` / `user` / `entryNode`) so a
 * CROSS-APP run-audit list can render names instead of raw cuids.
 *
 * The interesting part is not that they resolve — it's that each one is gated
 * on its OWN entity rather than on the outer `appRuns` org-READER gate. A
 * nested `App` hands the caller App's whole field-resolver surface, and
 * `App.keys` / `App.members` do NOT re-check (findings:broadening-read-gate-
 * leaks-nested-objects, #552). So these tests call the field resolvers
 * DIRECTLY with an unauthorized context — exactly the shape the outer gate
 * would otherwise hide.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const R = resolvers.AppRun as any;

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let member: { id: string };   // orgA member
let stranger: { id: string }; // member of NO org
let admin: { id: string };    // platform ADMIN
let appA: { id: string };
let agentA: { id: string };
let memA: { id: string; urn: string };
let entryNode: { id: string; loc: string };
let run: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'ar-a', urn: `ar-a-${generateId()}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'ar-b', urn: `ar-b-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 48101, githubUsername: 'ar-member' } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 48102, githubUsername: 'ar-stranger' } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 48103, githubUsername: 'ar-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' } });

  memA = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:mem`,
      name: 'ar mem', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  entryNode = await createDbNode(db, { loc: 'flow:entry', memoryId: memA.id, name: 'Entry' });
  agentA = await db.agent.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:agent`, name: 'Agent A', visibility: 'ORGANIZATION' },
  });
  appA = await db.app.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:app`, name: 'App A' },
  });
  run = await db.appRun.create({
    data: {
      id: generateId(), organizationId: orgA.id, appId: appA.id, agentId: agentA.id,
      userId: member.id, triggerKind: 'MANUAL',
      entryNodeUrn: `${memA.urn}:${entryNode.loc}`, status: 'COMPLETED',
    },
  });
});

const row = () => db.appRun.findUniqueOrThrow({ where: { id: run.id } });

describe('AppRun relations resolve for an authorized caller (#831)', () => {
  it('an orgA member gets app / agent / user / entryNode', async () => {
    const r = await row();
    const c = ctx(member.id);
    expect((await R.app(r, {}, c))?.id).toBe(appA.id);
    expect((await R.agent(r, {}, c))?.id).toBe(agentA.id);
    expect((await R.user(r, {}, c))?.id).toBe(member.id);
    expect((await R.entryNode(r, {}, c))?.id).toBe(entryNode.id);
  });

  it('a platform ADMIN gets them too', async () => {
    const r = await row();
    const c = ctx(admin.id, ['ADMIN']);
    expect((await R.app(r, {}, c))?.id).toBe(appA.id);
    expect((await R.agent(r, {}, c))?.id).toBe(agentA.id);
  });
});

describe('AppRun relations are gated on their OWN entity, not the run (#831/#552)', () => {
  it('a NON-MEMBER gets null for app — so App.keys / App.members stay unreachable', async () => {
    const r = await row();
    expect(await R.app(r, {}, ctx(stranger.id))).toBeNull();
    // The whole point: with a null App there is no object to hang key
    // previews or the member list off.
    await db.appKey.create({
      data: { id: generateId(), appId: appA.id, keyHash: `h-${generateId()}`, keyPreview: 'SECRET-PREVIEW' },
    });
    expect(await R.app(r, {}, ctx(stranger.id))).toBeNull();
  });

  it('an ANONYMOUS caller gets null for app', async () => {
    expect(await R.app(await row(), {}, ctx())).toBeNull();
  });

  it('a non-member gets null for agent (another org’s non-public agent)', async () => {
    expect(await R.agent(await row(), {}, ctx(stranger.id))).toBeNull();
  });

  it('a non-member gets null for entryNode (memory not readable)', async () => {
    expect(await R.entryNode(await row(), {}, ctx(stranger.id))).toBeNull();
  });

  // PR #853 review (Codex P1 / Copilot). Knowing `userId` does not authorize
  // the User record: only name/email/googleId/appleId have field resolvers, so
  // policy / identityProvider / externalId / roles / maxReferrals would resolve
  // by default and be exposed.
  it('a caller who shares NO org with the run user gets null for user', async () => {
    // A run on behalf of someone who is an App member/subscriber but not an
    // org co-member — exactly the shape an org audit list surfaces.
    const outsiderUser = await db.user.create({
      data: {
        id: generateId(), githubId: 48105, githubUsername: 'ar-outsider',
        roles: ['READER'], identityProvider: 'GITHUB', externalId: 'EXT-SECRET',
      },
    });
    const r2 = await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgA.id, appId: appA.id, userId: outsiderUser.id,
        triggerKind: 'MANUAL', entryNodeUrn: `${memA.urn}:${entryNode.loc}`, status: 'COMPLETED',
      },
    });
    const pr = await db.appRun.findUniqueOrThrow({ where: { id: r2.id } });
    // `member` is in orgA; the run user is in no org — no shared org.
    expect(await R.user(pr, {}, ctx(member.id))).toBeNull();
    expect(await R.user(pr, {}, ctx())).toBeNull();
    // Parity with the top-level read, which is the gate being mirrored.
    expect(await resolvers.Query.user(null, { ref: outsiderUser.id }, ctx(member.id))).toBeNull();
  });

  it('a co-member and the user themselves still resolve user', async () => {
    const r = await row(); // run.userId === member.id
    expect((await R.user(r, {}, ctx(member.id)))?.id).toBe(member.id);
    expect((await R.user(r, {}, ctx(admin.id, ['ADMIN'])))?.id).toBe(member.id);
  });

  it('a PUBLIC agent still resolves for an outsider (matches agent(ref:))', async () => {
    await db.agent.update({ where: { id: agentA.id }, data: { visibility: 'PUBLIC' } });
    expect((await R.agent(await row(), {}, ctx(stranger.id)))?.id).toBe(agentA.id);
  });

  it('a USER-OWNED App admits its owner and a platform admin, but not ordinary outsiders', async () => {
    const ownerUser = await db.user.create({
      data: { id: generateId(), githubId: 48104, githubUsername: 'ar-owner', handle: 'arowner' },
    });
    const personalApp = await db.app.create({
      data: { id: generateId(), ownerUserId: ownerUser.id, urn: `arowner:p-${generateId()}`, name: 'Personal' },
    });
    const personalRun = await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgA.id, appId: personalApp.id,
        triggerKind: 'MANUAL', entryNodeUrn: `${memA.urn}:${entryNode.loc}`, status: 'COMPLETED',
      },
    });
    const pr = await db.appRun.findUniqueOrThrow({ where: { id: personalRun.id } });
    expect((await R.app(pr, {}, ctx(ownerUser.id)))?.id).toBe(personalApp.id);
    expect(await R.app(pr, {}, ctx(member.id))).toBeNull();
    expect((await R.app(pr, {}, ctx(admin.id, ['ADMIN'])))?.id).toBe(personalApp.id);
  });
});

describe('AppRun relations degrade to null rather than failing the page (#831)', () => {
  it('entryNode is null when the node was deleted — entryNodeUrn stays the record', async () => {
    await db.node.delete({ where: { id: entryNode.id } });
    const r = await row();
    expect(await R.entryNode(r, {}, ctx(member.id))).toBeNull();
    expect(r.entryNodeUrn).toContain(entryNode.loc);
  });

  it('entryNode is null for an unresolvable / legacy URN', async () => {
    const bad = await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgA.id, appId: appA.id,
        triggerKind: 'MANUAL', entryNodeUrn: 'not-a-resolvable-urn', status: 'FAILED',
      },
    });
    expect(await R.entryNode(bad, {}, ctx(member.id))).toBeNull();
  });

  it('app is null when the App row was hard-deleted', async () => {
    const r = await row();
    await db.appRun.update({ where: { id: run.id } , data: { agentId: null } });
    await db.appAgent.deleteMany({ where: { appId: appA.id } });
    await db.app.delete({ where: { id: appA.id } });
    expect(await R.app(r, {}, ctx(member.id))).toBeNull();
  });

  it('agent and user are null when the run carries no agent / no user', async () => {
    const bare = await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgA.id, appId: appA.id,
        triggerKind: 'WEBHOOK', entryNodeUrn: `${memA.urn}:${entryNode.loc}`, status: 'PENDING',
      },
    });
    expect(await R.agent(bare, {}, ctx(member.id))).toBeNull();
    expect(await R.user(bare, {}, ctx(member.id))).toBeNull();
  });
});

describe('the relation loaders are request-memoized (#831/#853 — no N+1)', () => {
  it('agent and entryNode resolve through one cache entry across many rows', async () => {
    for (let i = 0; i < 5; i++) {
      await db.appRun.create({
        data: {
          id: generateId(), organizationId: orgA.id, appId: appA.id, agentId: agentA.id,
          triggerKind: 'MANUAL', entryNodeUrn: `${memA.urn}:${entryNode.loc}`, status: 'COMPLETED',
        },
      });
    }
    const rows = await db.appRun.findMany({ where: { appId: appA.id } });
    const c = ctx(member.id);
    const agents = await Promise.all(rows.map((r) => R.agent(r, {}, c)));
    const nodes = await Promise.all(rows.map((r) => R.entryNode(r, {}, c)));
    expect(agents.every((a) => a?.id === agentA.id)).toBe(true);
    expect(nodes.every((n) => n?.id === entryNode.id)).toBe(true);
    // One distinct agent and one distinct entry-node URN ⇒ one entry each,
    // not one per row (the membership query is shared too).
    expect(c.readableAgentCache?.size).toBe(1);
    expect(c.entryNodeCache?.size).toBe(1);
  });
});

describe('AppRun.app is request-memoized (#831 — no N+1 across a run page)', () => {
  it('many runs sharing one App resolve through a single cached load', async () => {
    for (let i = 0; i < 5; i++) {
      await db.appRun.create({
        data: {
          id: generateId(), organizationId: orgA.id, appId: appA.id,
          triggerKind: 'MANUAL', entryNodeUrn: `${memA.urn}:${entryNode.loc}`, status: 'COMPLETED',
        },
      });
    }
    const rows = await db.appRun.findMany({ where: { appId: appA.id } });
    expect(rows.length).toBeGreaterThan(5);
    // ONE shared request context, as a real GraphQL request would have.
    const c = ctx(member.id);
    const resolved = await Promise.all(rows.map((r) => R.app(r, {}, c)));
    expect(resolved.every((a) => a?.id === appA.id)).toBe(true);
    // One cache entry for the one distinct appId, not one per row.
    expect(c.appRowCache?.size).toBe(1);
  });
});
