/**
 * #1208 — group-class read gates must consult MemoryMember (cor:acl:010:01).
 *
 * Pins the three principal shapes the issue measured, one test per SHAPE (a
 * same-fixture test hides the class): an org member with NO MemoryMember row
 * must NOT reach a group memory; a MemoryMember with NO org role MUST reach
 * one; an org ADMIN with NO MemoryMember row does NOT reach one either —
 * the no-bypass default. These are written RED first against current main's
 * wide clause ('group' inside the knowledge clause, no MemoryMember anywhere
 * in the shared gates).
 *
 * The admin shape is a STANCE, not a claim that org admins should forever
 * need a MemoryMember row: whether org-level ADMIN/OWNER gets an implicit
 * group bypass is an open contract question for Holger (issue step 3). Until
 * he answers, this pins the narrow reading — MemoryMember-only, exactly what
 * cor:acl:010:01 says — so widening it later is a deliberate, reviewed
 * change rather than drift.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { getOrgReadableMemoryIds } from './orgReadableMemory.js';
import { canReadMemory } from '../../mcp/access-control.js';
import {
  getAccessibleMemoryIds,
  type Context,
} from '../../api/graphql/schema/resolvers.helpers.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { requireMemoryWriteAccess } from '../../api/graphql/schema/resolvers.helpers.js';
import { computeEffectiveAccess } from './effectiveAccess.js';

let org: { id: string; urn: string };
let orgB: { id: string; urn: string };
let groupMem: { id: string; urn: string };
let orgBGroupMem: { id: string; urn: string };
let knowledgeMem: { id: string };
let appScopedGroupMem: { id: string };
let orgMemberNoGroup: { id: string };
let orgAdminNoGroup: { id: string };
let orgContributorNoGroup: { id: string };
let memoryMemberNoOrgRole: { id: string };
let memoryMemberWriter: { id: string };
let memoryMemberOwner: { id: string };
let subscriberContributor: { id: string };
let crossOrgMember: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'g1208', urn: `g1208-${suffix}.com` } });
  groupMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:grp`, name: 'grp', class: 'group', visibility: 'GROUP' },
  });
  // #3567: an APP-SCOPED group row — its metadata must stay App-internal even
  // for org members (#653 record-side parity).
  const appRow = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'g1208app', urn: `${org.urn}:g1208app` },
  });
  appScopedGroupMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, appId: appRow.id, urn: `${org.urn}:agr`, name: 'agr', class: 'group', visibility: 'GROUP' },
  });
  knowledgeMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:km`, name: 'km', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  orgMemberNoGroup = await db.user.create({
    data: { id: generateId(), githubId: 12081, githubUsername: `g1208-org-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: orgMemberNoGroup.id, role: 'READER' },
  });
  orgAdminNoGroup = await db.user.create({
    data: { id: generateId(), githubId: 12083, githubUsername: `g1208-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: orgAdminNoGroup.id, role: 'ADMIN' },
  });
  memoryMemberNoOrgRole = await db.user.create({
    data: { id: generateId(), githubId: 12082, githubUsername: `g1208-mm-${suffix}`, roles: ['READER'] },
  });
  await db.memoryMember.create({
    data: { memoryId: groupMem.id, userId: memoryMemberNoOrgRole.id, role: 'reader' },
  });
  // #3595 shapes: a SECOND org with its own group, and a caller who is an
  // org-A member holding a MemoryMember row in org B's group — the
  // cross-org reach that must survive ORDINARY calls but vanish under an
  // impersonation session scoped to org A or an explicit orgId=A list.
  orgB = await db.organization.create({ data: { id: generateId(), name: 'g1208b', urn: `g1208b-${suffix}.com` } });
  orgBGroupMem = await db.memory.create({
    data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:grp`, name: 'grpB', class: 'group', visibility: 'GROUP' },
  });
  crossOrgMember = await db.user.create({
    data: { id: generateId(), githubId: 12084, githubUsername: `g1208-x-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: crossOrgMember.id, role: 'READER' },
  });
  await db.memoryMember.create({
    data: { memoryId: orgBGroupMem.id, userId: crossOrgMember.id, role: 'reader' },
  });
  // #3677 write-boundary shapes: an org CONTRIBUTOR with no MemoryMember row
  // (must NOT write), MemoryMember writer/owner rows (must write), and a
  // cross-org subscription CONTRIBUTOR (the subscription grant surface,
  // which stays).
  orgContributorNoGroup = await db.user.create({
    data: { id: generateId(), githubId: 12085, githubUsername: `g1208-c-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: orgContributorNoGroup.id, role: 'CONTRIBUTOR' },
  });
  memoryMemberWriter = await db.user.create({
    data: { id: generateId(), githubId: 12086, githubUsername: `g1208-w-${suffix}`, roles: ['READER'] },
  });
  await db.memoryMember.create({
    data: { memoryId: groupMem.id, userId: memoryMemberWriter.id, role: 'writer' },
  });
  memoryMemberOwner = await db.user.create({
    data: { id: generateId(), githubId: 12087, githubUsername: `g1208-o-${suffix}`, roles: ['READER'] },
  });
  await db.memoryMember.create({
    data: { memoryId: groupMem.id, userId: memoryMemberOwner.id, role: 'owner' },
  });
  subscriberContributor = await db.user.create({
    data: { id: generateId(), githubId: 12088, githubUsername: `g1208-s-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgB.id, userId: subscriberContributor.id, role: 'CONTRIBUTOR' },
  });
  await db.memorySubscription.create({
    data: { memoryId: groupMem.id, organizationId: orgB.id, role: 'CONTRIBUTOR' },
  });
});

function userCtx(userId: string) {
  return { db, userId, roles: [] } as never;
}

function gqlCtx(userId: string): Context {
  return { db, userId, roles: [] };
}

/** An impersonation session scoped to `orgId`, driven AS `userId` (#3595). */
function impersonationCtx(userId: string, orgId: string): Context {
  return {
    db,
    userId,
    roles: [],
    impersonation: {
      sessionId: generateId(),
      actorUserId: generateId(),
      orgId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  };
}

describe('#1208 group read gates vs MemoryMember (cor:acl:010:01)', () => {
  it('an org member with NO MemoryMember row does NOT reach a group memory', async () => {
    const ids = await getOrgReadableMemoryIds(db, orgMemberNoGroup.id);
    expect(ids).toContain(knowledgeMem.id); // knowledge stays org-visible
    expect(ids).not.toContain(groupMem.id); // group is MemoryMember-only — RED on main
  });

  it('a MemoryMember (reader) with NO org role DOES reach the group memory', async () => {
    const ids = await getOrgReadableMemoryIds(db, memoryMemberNoOrgRole.id);
    expect(ids).toContain(groupMem.id); // the join table's whole purpose — RED on main
  });

  it('an org ADMIN with NO MemoryMember row does NOT reach a group memory (no invented org-admin bypass)', async () => {
    const ids = await getOrgReadableMemoryIds(db, orgAdminNoGroup.id);
    expect(ids).toContain(knowledgeMem.id); // admin keeps org-wide knowledge
    expect(ids).not.toContain(groupMem.id); // MemoryMember-only per cor:acl:010:01; an org-level bypass is an OPEN option for Holger (#1208 step 3), not assumed here
  });

  it('canReadMemory agrees with the shared gate on both shapes (MCP parity)', async () => {
    expect(await canReadMemory(db, userCtx(orgMemberNoGroup.id), groupMem.id)).toBe(false);
    expect(await canReadMemory(db, userCtx(memoryMemberNoOrgRole.id), groupMem.id)).toBe(true);
  });

  it('the GraphQL point-read gate agrees (getAccessibleMemoryIds scoped control)', async () => {
    // The scoped form is the NODE-CONTENT point read (memoryAccessFilter /
    // node-search side) — the result is [id] or [] with no set enumeration,
    // same predicate as the unscoped gate by construction. It is NOT the
    // Query.memory(ref:) path: that record read goes through
    // canReadMemoryRecord first (controlled separately below, #3567).
    expect(await getAccessibleMemoryIds(gqlCtx(orgMemberNoGroup.id), groupMem.id)).toEqual([]);
    expect(await getAccessibleMemoryIds(gqlCtx(memoryMemberNoOrgRole.id), groupMem.id)).toEqual([
      groupMem.id,
    ]);
  });

  it('Query.memory(ref:) denies an org member without MemoryMember, serves a MemoryMember (#3567)', async () => {
    const Q = resolvers.Query as any;
    const denied = await Q.memory({}, { ref: groupMem.urn }, gqlCtx(orgMemberNoGroup.id));
    expect(denied).toBeNull(); // record fields (description/data/…) — RED before the record fix
    const allowed = await Q.memory({}, { ref: groupMem.urn }, gqlCtx(memoryMemberNoOrgRole.id));
    expect(allowed?.id).toBe(groupMem.id);
  });

  it('Query.memories lists group only through MemoryMember (#3567)', async () => {
    const Q = resolvers.Query as any;
    const orgMemberList = await Q.memories({}, {}, gqlCtx(orgMemberNoGroup.id));
    const orgMemberIds = orgMemberList.items.map((m: { id: string }) => m.id);
    expect(orgMemberIds).toContain(knowledgeMem.id); // knowledge stays listed
    expect(orgMemberIds).not.toContain(groupMem.id); // RED before the record fix

    const memberList = await Q.memories({}, {}, gqlCtx(memoryMemberNoOrgRole.id));
    expect(memberList.items.map((m: { id: string }) => m.id)).toContain(groupMem.id); // RED before the record fix
  });

  it('Query.memories does not leak app-scoped group metadata to org members (#3567)', async () => {
    const Q = resolvers.Query as any;
    const list = await Q.memories({}, {}, gqlCtx(orgMemberNoGroup.id));
    expect(list.items.map((m: { id: string }) => m.id)).not.toContain(appScopedGroupMem.id); // RED before the record fix
  });

  it('an impersonation session scoped to org A cannot reach the target\'s org-B group (node gate, #3595)', async () => {
    // crossOrgMember is an org-A member AND a MemoryMember in org B's group.
    // The shared-org session must see only org A: the org-B group is out even
    // though the TARGET holds a live MemoryMember row there.
    const ids = await getAccessibleMemoryIds(impersonationCtx(crossOrgMember.id, org.id), orgBGroupMem.id);
    expect(ids).toEqual([]); // RED before the org-bound fix
    // ...while the same caller's ORDINARY reach keeps the cross-org group.
    expect(await getOrgReadableMemoryIds(db, crossOrgMember.id)).toContain(orgBGroupMem.id);
  });

  it('an impersonation session scoped to org A cannot LIST the target\'s org-B group (#3595)', async () => {
    const Q = resolvers.Query as any;
    const list = await Q.memories({}, {}, impersonationCtx(crossOrgMember.id, org.id));
    const ids = list.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(knowledgeMem.id); // org A stays visible through the shared org
    expect(ids).not.toContain(orgBGroupMem.id); // RED before the org-bound fix
  });

  it('an explicit orgId=A list does not include the caller\'s group memory in org B (#3595)', async () => {
    const Q = resolvers.Query as any;
    const scoped = await Q.memories({}, { orgId: org.id }, gqlCtx(crossOrgMember.id));
    expect(scoped.items.map((m: { id: string }) => m.id)).not.toContain(orgBGroupMem.id); // RED before the org-bound fix
    // Unscoped, the same caller's cross-org MemoryMember reach is retained.
    const unscoped = await Q.memories({}, {}, gqlCtx(crossOrgMember.id));
    expect(unscoped.items.map((m: { id: string }) => m.id)).toContain(orgBGroupMem.id);
  });

  it('an org CONTRIBUTOR without MemoryMember cannot WRITE a group memory (#3677)', async () => {
    await expect(requireMemoryWriteAccess(gqlCtx(orgContributorNoGroup.id), groupMem.id)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    }); // RED before the write fix — org CONTRIBUTOR+ used to write any org memory
  });

  it('a MemoryMember WRITER with no org role can write; a READER cannot (#3677)', async () => {
    await expect(requireMemoryWriteAccess(gqlCtx(memoryMemberWriter.id), groupMem.id)).resolves.toBeUndefined(); // RED before the write fix
    await expect(requireMemoryWriteAccess(gqlCtx(memoryMemberNoOrgRole.id), groupMem.id)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    }); // pins writer-or-owner: a reader row grants read, never write
  });

  it('a MemoryMember OWNER can write a group memory (#3677)', async () => {
    await expect(requireMemoryWriteAccess(gqlCtx(memoryMemberOwner.id), groupMem.id)).resolves.toBeUndefined(); // RED before the write fix
  });

  it('a cross-org subscription CONTRIBUTOR still writes — the subscription grant surface is unchanged (#3677)', async () => {
    await expect(requireMemoryWriteAccess(gqlCtx(subscriberContributor.id), groupMem.id)).resolves.toBeUndefined(); // parity pin, green on both sides
  });

  it('effectiveAccess mirrors the enforced gates: no ORG_ROLE for group, MEMORY_MEMBER is the source (#3677)', async () => {
    const row = (await db.memory.findUnique({ where: { id: groupMem.id } }))!;
    // An org ADMIN with no MemoryMember row: the audit must not report the
    // old ORG_ROLE FULL — the enforced gates admit nothing.
    const admin = await computeEffectiveAccess(
      db,
      { id: orgAdminNoGroup.id, roles: ['READER'] },
      { kind: 'memory', memory: row as any },
    );
    expect(admin.canRead).toBe(false); // RED before the audit fix
    expect(admin.canWrite).toBe(false); // RED before the audit fix
    // A MemoryMember reader: exactly the reader caps, no more.
    const reader = await computeEffectiveAccess(
      db,
      { id: memoryMemberNoOrgRole.id, roles: [] },
      { kind: 'memory', memory: row as any },
    );
    expect(reader.canRead).toBe(true);
    expect(reader.canWrite).toBe(false);
  });
});
