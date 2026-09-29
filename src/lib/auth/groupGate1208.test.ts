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

let org: { id: string; urn: string };
let groupMem: { id: string };
let knowledgeMem: { id: string };
let orgMemberNoGroup: { id: string };
let orgAdminNoGroup: { id: string };
let memoryMemberNoOrgRole: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'g1208', urn: `g1208-${suffix}.com` } });
  groupMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:grp`, name: 'grp', class: 'group', visibility: 'GROUP' },
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
});

function userCtx(userId: string) {
  return { db, userId, roles: [] } as never;
}

function gqlCtx(userId: string): Context {
  return { db, userId, roles: [] };
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
    // The scoped form is the Query.memory(id:)/memoryAccessFilter path — the
    // result is [id] or [] with no set enumeration, same predicate as the
    // unscoped gate by construction (resolvers.helpers.ts).
    expect(await getAccessibleMemoryIds(gqlCtx(orgMemberNoGroup.id), groupMem.id)).toEqual([]);
    expect(await getAccessibleMemoryIds(gqlCtx(memoryMemberNoOrgRole.id), groupMem.id)).toEqual([
      groupMem.id,
    ]);
  });
});
