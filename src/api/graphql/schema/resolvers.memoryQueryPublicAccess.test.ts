/**
 * Issue #362 — Query.memory(id:) must honor the SAME read gate as the node
 * queries (nodeById/nodes), which route through memoryAccessFilter →
 * getAccessibleMemoryIds. Previously Query.memory had a bespoke
 * platform-admin-OR-org-member gate with no PUBLIC / subscription branch, so a
 * non-member whose only grant was PUBLIC_VISIBILITY → reader got `Forbidden`
 * even though they could read the memory's nodes — and the portal turned that
 * into an HTTP 500 on every memory-detail page.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

let orgA: { id: string };
let publicMem: { id: string };
let orgMem: { id: string };
let member: { id: string }; // member of orgA
let outsider: { id: string }; // member of NO org

beforeEach(async () => {
  await cleanDb(db);
  // A PUBLIC knowledge memory and an ORGANIZATION-visibility one, both in orgA.
  const pub = await createDbOrgAndGraph(db, { orgName: 'org-a', graphName: 'org-a/public', visibility: 'PUBLIC' });
  orgA = pub.org;
  publicMem = pub.graph;
  orgMem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      urn: 'org-a:org-a/private-ish',
      name: 'org-a/private-ish',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });

  member = await db.user.create({ data: { githubId: 7001, githubUsername: 'a-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 7002, githubUsername: 'an-outsider', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: member.id, role: 'READER' } });
});

const asMember = () => ctx({ userId: member.id, roles: ['READER'] });
const asOutsider = () => ctx({ userId: outsider.id, roles: ['READER'] });

describe('Query.memory(id:) — PUBLIC visibility (issue #362)', () => {
  it('lets a non-member read a PUBLIC memory (lockstep with the node gate)', async () => {
    const out = await resolvers.Query.memory(null, { id: publicMem.id }, asOutsider());
    expect(out?.id).toBe(publicMem.id);
  });

  it('lockstep check: the same outsider can also read the PUBLIC memory\'s nodes', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: publicMem.id, loc: 'pub-node', name: 'Pub' } });
    const nodes = await resolvers.Query.nodes(null, { memoryIds: [publicMem.id] }, asOutsider());
    expect(nodes.map((n: any) => n.loc)).toContain('pub-node');
  });

  it('still forbids a non-member on a non-PUBLIC (ORGANIZATION) memory', async () => {
    await expect(
      resolvers.Query.memory(null, { id: orgMem.id }, asOutsider()),
    ).rejects.toThrow('Forbidden');
  });

  it('an org member still reads an ORGANIZATION-visibility memory (no regression)', async () => {
    const out = await resolvers.Query.memory(null, { id: orgMem.id }, asMember());
    expect(out?.id).toBe(orgMem.id);
  });

  it('an unauthenticated caller can read a PUBLIC memory but not an ORGANIZATION one', async () => {
    expect((await resolvers.Query.memory(null, { id: publicMem.id }, ctx()))?.id).toBe(publicMem.id);
    await expect(resolvers.Query.memory(null, { id: orgMem.id }, ctx())).rejects.toThrow('Forbidden');
  });

  it('resolves the memory when given a URN, not just an id', async () => {
    const { urn } = await db.memory.findUniqueOrThrow({
      where: { id: publicMem.id },
      select: { urn: true },
    });
    const out = await resolvers.Query.memory(null, { id: urn }, asOutsider());
    expect(out?.id).toBe(publicMem.id);
  });

  it('a REVOKED (soft-deleted) member is denied on an ORGANIZATION memory', async () => {
    // Soft-delete the membership; the fast-path must treat it as revoked and
    // fall through to the shared gate (no public/subscription grant → denied).
    await db.orgMember.updateMany({
      where: { organizationId: orgA.id, userId: member.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      resolvers.Query.memory(null, { id: orgMem.id }, asMember()),
    ).rejects.toThrow('Forbidden');
    // The same revoked member can still read a PUBLIC memory (shared gate).
    expect((await resolvers.Query.memory(null, { id: publicMem.id }, asMember()))?.id).toBe(publicMem.id);
  });
});

describe('Query.memory(id:) — cross-org subscription (issue #362)', () => {
  it('lets a subscriber org member read the subscribed memory', async () => {
    // orgB subscribes to orgA's ORGANIZATION-visibility memory; a member of
    // orgB (member of NOT orgA) should now read it, matching the node gate.
    const orgB = await db.organization.create({ data: { id: generateId(), name: 'org-b', urn: 'org-b' } });
    await db.orgMember.create({ data: { organizationId: orgB.id, userId: outsider.id, role: 'READER' } });
    await db.memorySubscription.create({
      data: { id: generateId(), memoryId: orgMem.id, organizationId: orgB.id, role: 'READER' },
    });

    const out = await resolvers.Query.memory(null, { id: orgMem.id }, asOutsider());
    expect(out?.id).toBe(orgMem.id);
  });
});
