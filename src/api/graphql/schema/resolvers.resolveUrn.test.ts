import { withIncludeHistoryClientTransaction } from '../../../lib/includes/includeHistoryFence.js';
/**
 * Integration tests for Query.resolveUrn (hadron-portal#262).
 *
 * resolveUrn dispatches on a `urn:<type>:`-prefixed URN's type segment and
 * returns the ids the portal's /app/u/<urn> redirect route needs to reach
 * each resource's canonical page. It reuses the entity-ref resolvers and the
 * same per-kind authorization as the dedicated memory/node/org/agent/app
 * queries, collapsing both not-found and no-access to null so existence is
 * never disclosed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { buildNodeRevisionSnapshot, createNodeRevision } from '../../../lib/nodeRevisionSnapshot.js';
import { resolvers, type Context } from './resolvers.js';

const ORG_URN = 'urnres-org';
const MEM_URN = `${ORG_URN}:mem`;
const AGENT_URN = `${ORG_URN}:the-agent`;
const APP_URN = `${ORG_URN}:the-app`;
const NODE_LOC = 'topic';

let org: { id: string };
let memory: { id: string };
let node: { id: string };
let agent: { id: string };
let app: { id: string };
let member: { id: string }; // ADMIN of the org (so the app ADMIN gate passes)
let outsider: { id: string }; // member of no org

function memberCtx(): Context {
  return { db, userId: member.id, roles: ['READER'] };
}
function outsiderCtx(): Context {
  return { db, userId: outsider.id, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);

  org = await db.organization.create({
    data: { id: generateId(), name: 'urnres-org', urn: ORG_URN },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: MEM_URN,
      name: 'mem',
      class: 'knowledge',
      // ORGANIZATION-visible so the node-access filter (which respects
      // PRIVATE visibility, unlike the membership-only memory gate) admits
      // org members.
      visibility: 'ORGANIZATION',
    },
  });
  node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: NODE_LOC, name: 'Topic' },
  });
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: AGENT_URN, name: 'the-agent' },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, urn: APP_URN, name: 'the-app' },
  });

  member = await db.user.create({
    data: { id: generateId(), githubId: 7301, githubUsername: 'urnres-member', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' },
  });

  outsider = await db.user.create({
    data: { id: generateId(), githubId: 7302, githubUsername: `urnres-outsider-${generateId().slice(-8)}`, roles: ['READER'] },
  });
});

describe('Query.resolveUrn — resolves each kind for an authorized caller', () => {
  it('resolves a memory URN', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:memory:${MEM_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'memory', id: memory.id });
  });

  it('resolves a node URN and includes its memoryId', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:node:${MEM_URN}:${NODE_LOC}` },
      memberCtx(),
    );
    expect(r).toEqual({ kind: 'node', id: node.id, memoryId: memory.id });
  });

  it('resolves an org URN', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:org:${ORG_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'org', id: org.id });
  });

  it('resolves an agent URN', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:agent:${AGENT_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'agent', id: agent.id });
  });

  it('resolves an app URN and includes its organizationId', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:app:${APP_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'app', id: app.id, organizationId: org.id });
  });
});

describe('Query.resolveUrn — user (hrn:user:<handle>)', () => {
  it('resolves the caller themselves', async () => {
    await db.user.update({ where: { id: member.id }, data: { handle: 'urnres-self-h' } });
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:urnres-self-h' }, memberCtx());
    expect(r).toEqual({ kind: 'user', id: member.id });
  });

  it('resolves a user who shares an org with the caller', async () => {
    const peer = await db.user.create({
      data: { id: generateId(), githubId: 7303, githubUsername: 'urnres-peer', handle: 'urnres-peer-h', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: peer.id, role: 'READER' },
    });
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:urnres-peer-h' }, memberCtx());
    expect(r).toEqual({ kind: 'user', id: peer.id });
  });

  it('returns null for a user who shares no org with the caller', async () => {
    await db.user.update({ where: { id: member.id }, data: { handle: 'urnres-noshare-h' } });
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:urnres-noshare-h' }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('a platform admin resolves any user', async () => {
    await db.user.update({ where: { id: outsider.id }, data: { handle: 'urnres-outsider-h' } });
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: 'hrn:user:urnres-outsider-h' },
      { db, userId: member.id, roles: ['ADMIN'] },
    );
    expect(r).toEqual({ kind: 'user', id: outsider.id });
  });

  it('returns null for an unknown handle', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:nobody-urnres' }, memberCtx());
    expect(r).toBeNull();
  });
});

describe('Query.resolveUrn — access control collapses to null', () => {
  it('returns null for a memory the caller cannot access', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:memory:${MEM_URN}` }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('returns null for a node the caller cannot access', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:node:${MEM_URN}:${NODE_LOC}` },
      outsiderCtx(),
    );
    expect(r).toBeNull();
  });

  it('returns null for an org the caller is not a member of', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:org:${ORG_URN}` }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('returns null for an agent in an org the caller is not a member of', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:agent:${AGENT_URN}` }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('resolves an app for ANY member of its org, and null for a non-member (#473 app-gate parity)', async () => {
    // app(ref:) admits any org member since #473; resolveUrn mirrors it so a
    // member's /app/u/<app-urn> share link resolves to a page they can open.
    const contributor = await db.user.create({
      data: { id: generateId(), githubId: 7303, githubUsername: `urnres-contrib-${generateId().slice(-8)}`, roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
    const asMember = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:app:${APP_URN}` },
      { db, userId: contributor.id, roles: ['READER'] },
    );
    expect(asMember).toMatchObject({ kind: 'app' });

    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 7304, githubUsername: `urnres-outsider-${generateId().slice(-8)}`, roles: ['READER'] },
    });
    const asOutsider = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:app:${APP_URN}` },
      { db, userId: outsider.id, roles: ['READER'] },
    );
    expect(asOutsider).toBeNull();
  });
});

describe('Query.resolveUrn — unresolvable inputs return null', () => {
  it('returns null for a bare URN with no type prefix (kind ambiguous)', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: MEM_URN }, memberCtx());
    expect(r).toBeNull();
  });

  it('returns null for an unknown type segment', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: 'urn:bogus:foo:bar' }, memberCtx());
    expect(r).toBeNull();
  });

  it('returns null for a well-formed URN that names nothing', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${ORG_URN}:does-not-exist` },
      memberCtx(),
    );
    expect(r).toBeNull();
  });

  it('resolves for a global ADMIN regardless of membership', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${MEM_URN}` },
      { db, userId: outsider.id, roles: ['ADMIN'] },
    );
    expect(r).toEqual({ kind: 'memory', id: memory.id });
  });
});

// ─── #696: per-entity v2 shapes (apprun / noderev / #data fragment) ──────────
describe('Query.resolveUrn — #696 per-entity v2 shapes', () => {
  async function seedRun() {
    return db.appRun.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appId: app.id,
        agentId: agent.id,
        triggerKind: 'MANUAL',
        entryNodeUrn: `${MEM_URN}:flow:start`,
        status: 'RUNNING',
        data: { hello: 'world' },
      },
    });
  }

  it('resolves an apprun URN, and AppRun.urn round-trips through it', async () => {
    const run = await seedRun();
    // APP_URN is the bare <root>:<slug> form → hrn:apprun:<root>:<app>:<runId>.
    const urn = `hrn:apprun:${APP_URN}:${run.id}`;
    const r = await resolvers.Query.resolveUrn({}, { urn }, memberCtx());
    expect(r).toMatchObject({ kind: 'apprun', id: run.id, organizationId: org.id });

    // The computed AppRun.urn composes to exactly the URN that resolves back.
    const composed = await resolvers.AppRun.urn(run as never, {}, memberCtx());
    expect(composed).toBe(urn);
    const back = await resolvers.Query.resolveUrn({}, { urn: composed! }, memberCtx());
    expect(back).toMatchObject({ kind: 'apprun', id: run.id });
  });

  it('resolves an apprun #data fragment to the parent run, tagged fragment:data', async () => {
    const run = await seedRun();
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `hrn:apprun:${APP_URN}:${run.id}#data` },
      memberCtx(),
    );
    expect(r).toMatchObject({ kind: 'apprun', id: run.id, fragment: 'data' });
  });

  it('resolves a node #data fragment to the parent node, tagged fragment:data', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `hrn:node:${MEM_URN}:${NODE_LOC}#data` },
      memberCtx(),
    );
    expect(r).toMatchObject({ kind: 'node', id: node.id, memoryId: memory.id, fragment: 'data' });
  });

  it('rejects a #data fragment on a non-node/apprun parent', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `hrn:memory:${MEM_URN}#data` }, memberCtx());
    expect(r).toBeNull();
  });

  it('mints monotonic revNo and resolves the noderev URN (round-trips)', async () => {
    const editor = { userId: member.id };
    const snap = () =>
      withIncludeHistoryClientTransaction(db, (tx) => createNodeRevision(tx,
        buildNodeRevisionSnapshot({ ...node, memoryId: memory.id, loc: NODE_LOC, name: 'Topic' } as never, editor),
      ));
    await snap();
    await snap();

    const revs = await db.nodeRevision.findMany({
      where: { nodeId: node.id },
      orderBy: { revNo: 'asc' },
      select: { id: true, revNo: true },
    });
    expect(revs.map((r) => r.revNo)).toEqual([1, 2]);
    const refreshed = await db.node.findUniqueOrThrow({ where: { id: node.id }, select: { revSeq: true } });
    expect(refreshed.revSeq).toBe(3);

    // Resolve r2 by its end-anchored URN, and confirm NodeRevision.urn round-trips.
    const urn = `hrn:noderev:${MEM_URN}:${NODE_LOC}:r2`;
    const r = await resolvers.Query.resolveUrn({}, { urn }, memberCtx());
    expect(r).toMatchObject({ kind: 'noderev', id: revs[1]!.id, memoryId: memory.id });

    const row = await db.nodeRevision.findUniqueOrThrow({
      where: { id: revs[1]!.id },
      select: { id: true, loc: true, revNo: true, memoryId: true, nodeId: true },
    });
    const composed = await resolvers.NodeRevision.urn(row as never, {}, memberCtx());
    expect(composed).toBe(urn);
  });
});

/**
 * #1104 — the memory branch's gate is `isOwnerOrOrgMember`, a generic
 * org/owner predicate, applied to an entity whose access is CLASS-driven.
 * Diagnosed by @Gil on portal#630 (a share grantee refused), and wrong in BOTH
 * directions once measured: the same generic gate is too NARROW for a
 * user-owned memory (it cannot see a share) and too WIDE for an org-owned
 * personal one (it falls through to org membership, which no personal memory
 * grants). Fixed by using `canReadMemoryRecord` — the same gate `Query.memory`
 * uses, which is what makes the two addresses of one memory agree by
 * construction rather than by a second hand-rolled copy.
 *
 * Both directions are asserted against `Query.memory` as well as against an
 * expectation, because "these two agree" is the actual contract: the URN is the
 * form we ask people to share, so it must not be the one address that differs.
 */
describe('Query.resolveUrn — the memory gate matches Query.memory (#1104)', () => {
  /** Owner of the personal memories below; never the caller under test. */
  let secretOwner: { id: string };
  /** Org member holding a `reader` MemoryShare on the user-owned memory. */
  let grantee: { id: string };
  /** Org member with NO share — the too-wide direction. */
  let bystander: { id: string };
  let userOwnedPersonal: { id: string; urn: string };
  let orgOwnedPersonal: { id: string; urn: string };

  const ctxFor = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });

  beforeEach(async () => {
    secretOwner = await db.user.create({
      data: { id: generateId(), githubId: 7310, githubUsername: `urnres-owner-${generateId().slice(-8)}`, roles: ['READER'] },
    });
    grantee = await db.user.create({
      data: { id: generateId(), githubId: 7311, githubUsername: `urnres-grantee-${generateId().slice(-8)}`, roles: ['READER'] },
    });
    bystander = await db.user.create({
      data: { id: generateId(), githubId: 7312, githubUsername: `urnres-bystander-${generateId().slice(-8)}`, roles: ['READER'] },
    });
    for (const u of [secretOwner, grantee, bystander]) {
      await db.orgMember.create({
        data: { id: generateId(), organizationId: org.id, userId: u.id, role: 'READER' },
      });
    }

    // Free-standing / user-owned (spec 047): org NULL, ownerUserId = owner.
    // This is the shape portal#630 hit — `hrn:mem:<user>:<slug>`.
    userOwnedPersonal = await db.memory.create({
      data: {
        id: generateId(),
        urn: `${secretOwner.id}:urnres-user-owned`,
        name: 'urnres-user-owned',
        class: 'personal',
        userId: secretOwner.id,
        ownerUserId: secretOwner.id,
      },
    });
    await db.memoryShare.create({
      data: {
        memoryId: userOwnedPersonal.id,
        granteeId: grantee.id,
        grantorId: secretOwner.id,
        role: 'reader',
      },
    });

    // Org-owned personal: org SET, ownerUserId NULL — the shape that makes the
    // generic gate fall through to org membership.
    orgOwnedPersonal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${ORG_URN}:urnres-org-owned-personal`,
        name: 'urnres-org-owned-personal',
        class: 'personal',
        userId: secretOwner.id,
      },
    });
  });

  it('resolves a SHARED memory for its grantee — the URN must not be the one address that fails', async () => {
    // portal#630. The grantee can already list this memory under "shared with
    // me", open it at /app/memories/<pk> and read its nodes; only /app/u/<urn>
    // refused, and the URN is the form we ask people to hand each other.
    const ctx = ctxFor(grantee);
    await expect(
      resolvers.Query.memory({}, { ref: userOwnedPersonal.id }, ctx),
    ).resolves.toMatchObject({ id: userOwnedPersonal.id });
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${userOwnedPersonal.urn}` },
      ctx,
    );
    expect(r).toEqual({ kind: 'memory', id: userOwnedPersonal.id });
  });

  it('still refuses a user-owned memory to a non-grantee', async () => {
    // The narrowing control: the fix must admit the grantee WITHOUT admitting
    // every org member, or it trades one direction of the bug for the other.
    const ctx = ctxFor(bystander);
    // Both point-read surfaces collapse denial to null so neither discloses
    // whether the named memory exists (#1316).
    await expect(
      resolvers.Query.memory({}, { ref: userOwnedPersonal.id }, ctx),
    ).resolves.toBeNull();
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${userOwnedPersonal.urn}` },
      ctx,
    );
    expect(r).toBeNull();
  });

  it('does NOT resolve another member\'s ORG-OWNED personal memory — an existence oracle', async () => {
    // The other direction, found by reading the gate rather than the issue.
    // `isOwnerOrOrgMember` short-circuits to org membership when ownerUserId is
    // NULL — but NO personal memory is readable by org membership
    // (`cor:acl:010:01`: personal is owner-only). So resolveUrn handed any org
    // member the memory's PK for a memory `Query.memory` then refuses to open.
    // Not a content leak — a confirmation that a named personal memory EXISTS,
    // plus its id, which is exactly what collapsing not-found and no-access to
    // null is supposed to prevent.
    const ctx = ctxFor(bystander);
    await expect(
      resolvers.Query.memory({}, { ref: orgOwnedPersonal.id }, ctx),
    ).resolves.toBeNull();
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${orgOwnedPersonal.urn}` },
      ctx,
    );
    expect(r).toBeNull();
  });

  it('still resolves the owner\'s OWN personal memory', async () => {
    // The second narrowing control — the owner is the one principal a
    // personal memory admits, so a fix that denies them denies everybody.
    const ctx = ctxFor(secretOwner);
    for (const m of [userOwnedPersonal, orgOwnedPersonal]) {
      expect(
        await resolvers.Query.resolveUrn({}, { urn: `urn:memory:${m.urn}` }, ctx),
      ).toEqual({ kind: 'memory', id: m.id });
    }
  });
});
