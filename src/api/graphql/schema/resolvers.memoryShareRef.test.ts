/**
 * #769 — the memory-share mutations accept a grantee REFERENCE (id / email /
 * handle / hrn:user URN) resolved server-side, so a personal memory can be
 * shared with someone OUTSIDE the caller's org (whom the caller can't otherwise
 * look up). The legacy `granteeId` PK still works.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

let org: { id: string };
let owner: { id: string };
let grantee: { id: string; handle: string; email: string };
const asOwner = (): Context => ({ db, userId: owner.id, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, {
    orgName: 'share-org',
    graphName: 'share/repo',
    visibility: 'ORGANIZATION',
  });
  org = a.org;
  owner = await db.user.create({
    data: { id: generateId(), githubId: 6001, githubUsername: 'share-owner', roles: ['READER'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'READER' } });
  // The grantee is deliberately NOT a member of the owner's org — the cross-org
  // case #769 targets (the caller can't resolve them via the access-scoped
  // user lookups, only server-side).
  const handle = `grantee-${generateId().slice(-8)}`;
  const email = `${handle}@example.com`;
  const g = await db.user.create({ data: { id: generateId(), handle, email, roles: ['READER'] } });
  grantee = { id: g.id, handle, email };
});

// #778: cross-org sharing (this suite's whole point — sharing with a user
// OUTSIDE the caller's org) is allowed only for FREE-STANDING personal memories.
// An org-owned personal memory may be shared only within its org. So these
// fixtures omit orgId → the memory is owned by the caller directly (org-less).
async function sharablePersonal(name = 'sharable') {
  return M.createMemory(null, { name, memoryClass: 'personal' }, asOwner());
}

describe('createMemoryShare — granteeRef resolution (#769)', () => {
  it('shares to a cross-org user by email (case-insensitive)', async () => {
    const mem = await sharablePersonal();
    const { memoryShare } = await M.createMemoryShare(
      null,
      { memoryId: mem.id, granteeRef: grantee.email.toUpperCase(), role: 'writer' },
      asOwner(),
    );
    expect(memoryShare.granteeId).toBe(grantee.id);
  });

  it('shares by handle and by hrn:user URN', async () => {
    const m1 = await sharablePersonal('by-handle');
    const s1 = await M.createMemoryShare(
      null,
      { memoryId: m1.id, granteeRef: grantee.handle, role: 'reader' },
      asOwner(),
    );
    expect(s1.memoryShare.granteeId).toBe(grantee.id);

    const m2 = await sharablePersonal('by-urn');
    const s2 = await M.createMemoryShare(
      null,
      { memoryId: m2.id, granteeRef: `hrn:user:${grantee.handle}`, role: 'reader' },
      asOwner(),
    );
    expect(s2.memoryShare.granteeId).toBe(grantee.id);
  });

  it('still accepts the legacy granteeId (PK)', async () => {
    const mem = await sharablePersonal('by-pk');
    const { memoryShare } = await M.createMemoryShare(
      null,
      { memoryId: mem.id, granteeId: grantee.id, role: 'reader' },
      asOwner(),
    );
    expect(memoryShare.granteeId).toBe(grantee.id);
  });

  it('rejects an unknown granteeRef with NOT_FOUND', async () => {
    const mem = await sharablePersonal('unknown');
    await expect(
      M.createMemoryShare(
        null,
        { memoryId: mem.id, granteeRef: 'nobody@nowhere.example', role: 'reader' },
        asOwner(),
      ),
    ).rejects.toThrow(/No user matches granteeRef/);
  });

  it('requires a grantee', async () => {
    const mem = await sharablePersonal('missing');
    await expect(
      M.createMemoryShare(null, { memoryId: mem.id, role: 'reader' }, asOwner()),
    ).rejects.toThrow(/grantee is required/i);
  });
});

describe('revoke / update by granteeRef (#769)', () => {
  it('deleteMemoryShare resolves the ref and returns the resolved PK', async () => {
    const mem = await sharablePersonal('revoke');
    await M.createMemoryShare(null, { memoryId: mem.id, granteeRef: grantee.email, role: 'reader' }, asOwner());
    const res = await M.deleteMemoryShare(null, { memoryRef: mem.id, granteeRef: grantee.handle }, asOwner());
    expect(res.granteeId).toBe(grantee.id);
    expect(await db.memoryShare.findFirst({ where: { memoryId: mem.id, granteeId: grantee.id } })).toBeNull();
  });

  it('updateMemoryShareRole resolves the ref', async () => {
    const mem = await sharablePersonal('update');
    await M.createMemoryShare(null, { memoryId: mem.id, granteeRef: grantee.handle, role: 'reader' }, asOwner());
    const { memoryShare } = await M.updateMemoryShareRole(
      null,
      { memoryId: mem.id, granteeRef: grantee.email, role: 'writer' },
      asOwner(),
    );
    expect(memoryShare.granteeId).toBe(grantee.id);
    expect(memoryShare.role).toBe('writer');
  });
});

describe('granteeRef edge cases (#774 review)', () => {
  it('rejects an ambiguous case-insensitive email, but an exact-case match wins', async () => {
    const mem = await sharablePersonal('amb');
    // Two accounts differing ONLY by email case (email is case-sensitively unique).
    const lower = await db.user.create({
      data: { id: generateId(), handle: `amb-l-${generateId().slice(-6)}`, email: 'amb@example.com', roles: ['READER'] },
    });
    await db.user.create({
      data: { id: generateId(), handle: `amb-u-${generateId().slice(-6)}`, email: 'Amb@example.com', roles: ['READER'] },
    });
    // No exact-case row for the all-caps form → two insensitive matches → reject.
    await expect(
      M.createMemoryShare(null, { memoryId: mem.id, granteeRef: 'AMB@example.com', role: 'reader' }, asOwner()),
    ).rejects.toThrow(/more than one account/);
    // The exact-case email disambiguates to that specific account.
    const { memoryShare } = await M.createMemoryShare(
      null,
      { memoryId: mem.id, granteeRef: 'amb@example.com', role: 'reader' },
      asOwner(),
    );
    expect(memoryShare.granteeId).toBe(lower.id);
  });

  it('rejects passing both granteeRef and granteeId', async () => {
    const mem = await sharablePersonal('both');
    await expect(
      M.createMemoryShare(
        null,
        { memoryId: mem.id, granteeRef: grantee.handle, granteeId: grantee.id, role: 'reader' },
        asOwner(),
      ),
    ).rejects.toThrow(/not both/);
  });
});

describe('Memory.shareable derived signal (#766)', () => {
  const Mem = resolvers.Memory as any;

  it('is true for a personal-class memory', async () => {
    const mem = await sharablePersonal('shareable-yes');
    // From a fully-loaded graphroot (class present).
    expect(await Mem.shareable({ id: mem.id, class: 'personal' }, {}, asOwner())).toBe(true);
  });

  it('is false for a non-personal (knowledge) memory', async () => {
    // Class present on the graphroot → resolved without a db read.
    expect(await Mem.shareable({ id: 'irrelevant', class: 'knowledge' }, {}, asOwner())).toBe(false);
  });

  it('fetches class when the query path did not load it (partial-select-safe)', async () => {
    const mem = await sharablePersonal('shareable-partial');
    expect(await Mem.shareable({ id: mem.id }, {}, asOwner())).toBe(true);
  });
});

describe('createMemoryShare non-personal error (#766)', () => {
  it('names the rule and the offending class', async () => {
    // Use an owner-held private memory: the caller-authority guard passes
    // (memory.userId === caller) so the class check actually runs and throws
    // InvalidMemoryClassForShareError (a non-owned class like knowledge would
    // short-circuit to FORBIDDEN first — see mentor-isolation.test.ts).
    const priv = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.id}:owner:private-766`,
        name: 'owner private',
        class: 'private',
        visibility: null,
        userId: owner.id,
      },
    });
    await expect(
      M.createMemoryShare(null, { memoryId: priv.id, granteeRef: grantee.handle, role: 'reader' }, asOwner()),
    ).rejects.toThrow(/only personal-class memories can be shared.*class='private'/s);
  });
});
