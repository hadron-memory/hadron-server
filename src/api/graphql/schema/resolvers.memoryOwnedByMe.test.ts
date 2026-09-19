/**
 * #1176 + #1179 — the memory LIST surface and user ownership.
 *
 * Two issues, one predicate. `Memory` carries TWO user columns and they are
 * independent axes:
 *
 *   - `ownerUserId` — the spec-047 user TENANT owner. XOR with
 *     `organizationId` (`chk_memory_owner_xor`), so a free-standing memory
 *     always HAS an owner. Class-independent.
 *   - `userId` — the personal/private STRICT owner, tied to the class by
 *     `chk_personal_visibility_user` (an equivalence).
 *
 * **#1176:** `Query.memories`' JWT union had NO `ownerUserId` clause, so a
 * user-owned memory outside `personal`/`private` was absent from the only
 * surface that enumerates a user's memories — while `getAccessibleMemoryIds`
 * (every node read), `canReadMemoryRecord` (`memory(ref:)`), MCP's
 * `getMemoryAccess` and `scopes.ts` all admitted it. `cor:api:120:03` makes
 * "default = accessible set" DURABLE, so that was a spec violation. It is also
 * the whole of the reported symptom (`hrn:mem:holger:holgers-gear` readable by
 * URN, returned by `hadron_list_memories`, missing from the portal's list):
 * nothing about the DATA needed changing, and no schema change was involved.
 *
 * **#1179:** `filter.ownedByMe`, the memory twin of `agents`/`apps` (#782) —
 * the same predicate, so the three read identically.
 *
 * The two ship together because the filter can only ever NARROW the union
 * (`cor:api:120:03`): asking for rows the union does not contain returns an
 * empty page. That dependency is asserted directly below, in
 * "the filter narrows the union rather than replacing it".
 *
 * Fixture discipline (`review:narrow-to-every-discriminator-the-spec-names`):
 * the slice's discriminators are `organizationId IS NULL`, `ownerUserId =
 * caller`, class-independence, the identity scope (impersonation), the
 * principal shape, and the documented list-surface exclusions. There is one
 * fixture per discriminator, and in particular BOTH ownership columns appear in
 * isolation — an org-owned `personal` row (`userId` set, `ownerUserId` NULL)
 * and a user-owned `knowledge` row (the reverse) — because a fixture where the
 * two coincide makes a predicate keyed on either look right.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds } from './resolvers.helpers.js';

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

type Fixture = {
  ownerId: string;
  otherId: string;
  orgId: string;
  /** org NULL + ownerUserId=owner, class knowledge — the reported shape. */
  userOwnedKnowledge: string;
  /** org NULL + ownerUserId=owner + userId=owner, class personal. */
  userOwnedPersonal: string;
  /** org SET + userId=owner, class personal — `userId` without `ownerUserId`. */
  orgOwnedPersonal: string;
  /** org SET, class knowledge — readable by the owner via membership only. */
  orgKnowledge: string;
  /** org NULL + ownerUserId=owner, class system — hidden by the class default. */
  userOwnedSystem: string;
  /** org NULL + ownerUserId=other, class personal, shared WITH owner. */
  sharedWithOwner: string;
  /** org NULL + ownerUserId=owner + userMemoryOfAgentId set — a chatbot holding. */
  userOwnedHolding: string;
};

let f: Fixture;

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({
    data: { githubId: 7101, githubUsername: 'obm-owner', handle: 'obm-owner', roles: ['READER'] },
  });
  const other = await db.user.create({
    data: { githubId: 7102, githubUsername: 'obm-other', handle: 'obm-other', roles: ['READER'] },
  });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'obm-org', urn: `obm-org-${generateId()}` },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: owner.id, role: 'READER' },
  });

  // A holding memory needs an Agent to hold it (`userMemoryOfAgentId`).
  const holdingAgent = await db.agent.create({
    data: {
      id: generateId(),
      name: 'OBM Agent',
      urn: `${org.urn}:obm-agent`,
      organizationId: org.id,
      visibility: 'ORGANIZATION',
    },
  });

  const mem = async (data: Record<string, unknown>) =>
    (
      await db.memory.create({
        data: {
          id: generateId(),
          urn: `obm-${generateId()}`,
          ...data,
        } as never,
      })
    ).id;

  f = {
    ownerId: owner.id,
    otherId: other.id,
    orgId: org.id,
    userOwnedKnowledge: await mem({
      class: 'knowledge',
      name: 'Owner Gear',
      ownerUserId: owner.id,
      visibility: 'ORGANIZATION',
    }),
    userOwnedPersonal: await mem({
      class: 'personal',
      name: 'Owner Notes',
      ownerUserId: owner.id,
      userId: owner.id,
    }),
    orgOwnedPersonal: await mem({
      class: 'personal',
      name: 'Org Personal',
      organizationId: org.id,
      userId: owner.id,
    }),
    orgKnowledge: await mem({
      class: 'knowledge',
      name: 'Org Knowledge',
      organizationId: org.id,
      visibility: 'ORGANIZATION',
    }),
    userOwnedSystem: await mem({
      class: 'system',
      name: 'Owner System',
      ownerUserId: owner.id,
    }),
    sharedWithOwner: await mem({
      class: 'personal',
      name: 'Other Notes',
      ownerUserId: other.id,
      userId: other.id,
    }),
    userOwnedHolding: await mem({
      class: 'knowledge',
      name: 'Owner Holding',
      ownerUserId: owner.id,
      userMemoryOfAgentId: holdingAgent.id,
      createdBy: owner.id,
    }),
  };
  await db.memoryShare.create({
    data: {
      memoryId: f.sharedWithOwner,
      grantorId: other.id,
      granteeId: owner.id,
      role: 'reader',
    },
  });
});

/** ids of one page, for set assertions that name what is present AND absent. */
const ids = (page: { items: { id: string }[] }) => page.items.map((m) => m.id);

const list = (
  filter: Record<string, unknown> | null,
  over: Partial<Context>,
  orgId?: string | null,
) => resolvers.Query.memories(null, { filter, orgId }, ctx(over));

// ---------------------------------------------------------------------------
// #1176 — the default (unfiltered) list IS the caller's accessible set.
// ---------------------------------------------------------------------------

describe('#1176 — memories() folds in the caller’s own user-owned rows', () => {
  it('lists a user-owned knowledge memory for its owner (the reported bug)', async () => {
    const page = await list(null, { userId: f.ownerId, roles: ['READER'] });
    expect(ids(page)).toContain(f.userOwnedKnowledge);
  });

  it('does NOT list it for a different user', async () => {
    const page = await list(null, { userId: f.otherId, roles: ['READER'] });
    expect(ids(page)).not.toContain(f.userOwnedKnowledge);
  });

  it('does NOT list another user’s user-owned row to a platform ADMIN', async () => {
    // Strict ownership has no admin bypass on any surface (cor:api:120:03).
    const page = await list(null, { userId: f.otherId, roles: ['ADMIN'] });
    expect(ids(page)).not.toContain(f.userOwnedKnowledge);
  });

  it('does NOT list the target’s user-owned rows to an impersonated session', async () => {
    // Identity-scoped clauses are dropped under impersonation, exactly as
    // getAccessibleMemoryIds drops them (#876).
    const page = await list(null, {
      userId: f.ownerId,
      roles: ['READER'],
      impersonation: {
        sessionId: 's',
        actorUserId: f.otherId,
        orgId: f.orgId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    } as Partial<Context>);
    expect(ids(page)).not.toContain(f.userOwnedKnowledge);
    // …while the shared-org set it IS entitled to still comes back, so the
    // assertion above is about the identity scope and not about an empty page.
    expect(ids(page)).toContain(f.orgKnowledge);
  });

  it('keeps the caller’s own user-owned row when an active org is selected', async () => {
    // cor:api:120:03: "selecting an active org must not hide your own notes."
    // This is where the memory surface deliberately DIFFERS from agents(),
    // which drops its user-owned fold under an explicit orgId.
    const page = await list(null, { userId: f.ownerId, roles: ['READER'] }, f.orgId);
    expect(ids(page)).toContain(f.userOwnedKnowledge);
    expect(ids(page)).toContain(f.orgKnowledge);
  });

  it('still hides a user-owned SYSTEM memory by default, and shows it when asked', async () => {
    // The class filter composes with the new clause rather than being bypassed
    // by it — the noisy agent system class stays opt-in.
    const dflt = await list(null, { userId: f.ownerId, roles: ['READER'] });
    expect(ids(dflt)).not.toContain(f.userOwnedSystem);
    const asked = await list({ memoryClasses: ['system'] }, { userId: f.ownerId, roles: ['READER'] });
    expect(ids(asked)).toContain(f.userOwnedSystem);
  });

  it('does not fold a share grant into the default list (the documented exclusion)', async () => {
    // cor:api:120:03 — share grants are reachable ONLY via the sharedWithMe
    // slice. Widening the union must not have quietly taken that with it.
    const page = await list(null, { userId: f.ownerId, roles: ['READER'] });
    expect(ids(page)).not.toContain(f.sharedWithOwner);
  });
});

/**
 * The defect was a DIVERGENCE: four read surfaces admitted the row and the list
 * did not. #1092's parity table pins the READ gates against each other but has
 * no LIST column, which is why this survived it. This is that column, for the
 * one shape at issue.
 *
 * The invariant is not "list == accessible set" — the list is deliberately
 * narrower (share grants, per-user agent holdings, the system-class default).
 * It is: a memory in the accessible set is listed UNLESS a documented
 * list-surface rule excludes it.
 */
describe('#1176 — the list does not diverge from the node read gate', () => {
  it('lists every accessible memory that no documented rule excludes', async () => {
    const over = { userId: f.ownerId, roles: ['READER'] as string[] };
    const accessible = (await getAccessibleMemoryIds(ctx(over))) ?? [];
    const listed = ids(await list(null, over));

    // Documented list-surface exclusions, named rather than inferred from the
    // diff: share grants (the sharedWithMe slice), the system class (opt-in),
    // and per-user agent holdings (the chatbot flow). Each is a rule in
    // cor:api:120:03; a row appearing here for any OTHER reason is the drift
    // this test exists to catch.
    const excluded = new Set([f.sharedWithOwner, f.userOwnedSystem, f.userOwnedHolding]);
    const expected = accessible.filter((id) => !excluded.has(id));

    expect(expected.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...new Set(expected)].sort());
  });
});

// ---------------------------------------------------------------------------
// #1179 — filter.ownedByMe
// ---------------------------------------------------------------------------

describe('#1179 — filter.ownedByMe', () => {
  const owned = (over: Partial<Context>, extra: Record<string, unknown> = {}, orgId?: string) =>
    list({ ownedByMe: true, ...extra }, over, orgId);

  it('returns the caller’s user-owned rows of ANY class', async () => {
    const page = await owned({ userId: f.ownerId, roles: ['READER'] });
    expect(ids(page)).toContain(f.userOwnedKnowledge);
    expect(ids(page)).toContain(f.userOwnedPersonal);
  });

  it('excludes an ORG-owned personal memory the caller is the strict owner of', async () => {
    // THE discriminator between the two columns: `userId` = caller here, and
    // `ownerUserId` is NULL. A filter keyed on `userId` or on the class would
    // return this row; the slice is user-owned TENANCY, and this row's tenant
    // is the org. It is also what the portal's existing query already excluded
    // client-side, so the population does not change under it.
    const page = await owned({ userId: f.ownerId, roles: ['READER'] });
    expect(ids(page)).not.toContain(f.orgOwnedPersonal);
  });

  it('excludes org memories the caller reads through membership', async () => {
    const page = await owned({ userId: f.ownerId, roles: ['READER'] });
    expect(ids(page)).not.toContain(f.orgKnowledge);
  });

  it('excludes another user’s user-owned rows, including from a platform ADMIN', async () => {
    const asOther = await owned({ userId: f.otherId, roles: ['READER'] });
    expect(ids(asOther)).not.toContain(f.userOwnedKnowledge);
    const asAdmin = await owned({ userId: f.otherId, roles: ['ADMIN'] });
    expect(ids(asAdmin)).not.toContain(f.userOwnedKnowledge);
    // An admin's OWN user-owned rows still appear — the slice narrows, and the
    // absence above is ownership, not an empty page.
    expect(ids(asAdmin)).toContain(f.sharedWithOwner);
  });

  it('gives an App-key caller an empty page', async () => {
    const app = await db.app.create({
      data: { id: generateId(), name: 'OBM App', urn: `obm-app-${generateId()}`, ownerUserId: f.ownerId },
    });
    const page = await owned({ appId: app.id, roles: ['READER'] });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('gives an impersonated session an empty page', async () => {
    const page = await owned({
      userId: f.ownerId,
      roles: ['READER'],
      impersonation: {
        sessionId: 's',
        actorUserId: f.otherId,
        orgId: f.orgId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    } as Partial<Context>);
    expect(page.items).toEqual([]);
  });

  it('is empty when combined with visibility PUBLIC', async () => {
    // #758 pins `ownerUserId: null` on the marketplace slice, so the two
    // clauses have no intersection. Empty by construction, and stated rather
    // than left to a predicate collision.
    await db.memory.update({
      where: { id: f.userOwnedKnowledge },
      data: { visibility: 'PUBLIC' },
    });
    const page = await owned({ userId: f.ownerId, roles: ['READER'] }, { visibility: 'PUBLIC' });
    expect(page.items).toEqual([]);
  });

  it('narrows the sharedWithMe slice rather than replacing it', async () => {
    // A memory granted TO the caller is not one they own, so ANDing the two
    // clauses is empty — where picking one branch over the other would have
    // answered a question nobody asked.
    const both = await owned({ userId: f.ownerId, roles: ['READER'] }, { sharedWithMe: true });
    expect(ids(both)).not.toContain(f.sharedWithOwner);
    expect(ids(both)).not.toContain(f.userOwnedKnowledge);
    // The slice itself still works on its own — proving the line above is a
    // narrowing and not a broken sharedWithMe.
    const shared = await list({ sharedWithMe: true }, { userId: f.ownerId, roles: ['READER'] });
    expect(ids(shared)).toContain(f.sharedWithOwner);
  });

  it('does not consult orgId — a foreign org neither empties nor narrows it', async () => {
    // Sibling parity (#782): the slice is org-less by definition, so it skips
    // the org-scope resolution entirely. Nothing is disclosed by that, because
    // every row it returns is the caller's own and belongs to no org.
    const foreign = await db.organization.create({
      data: { id: generateId(), name: 'obm-foreign', urn: `obm-foreign-${generateId()}` },
    });
    const page = await owned({ userId: f.ownerId, roles: ['READER'] }, {}, foreign.id);
    expect(ids(page)).toContain(f.userOwnedKnowledge);
  });

  it('excludes a per-user agent HOLDING the caller owns', async () => {
    // cor:api:120:03 keeps chatbot holdings out of the regular memory list, so
    // the owner slice must exclude them too — a filter that surfaced rows the
    // default list hides would WIDEN rather than narrow. Nothing in production
    // is currently both user-owned and a holding (0 of 24 measured), which is
    // precisely why this needs a fixture rather than a reading of the column.
    const page = await owned({ userId: f.ownerId, roles: ['READER'] });
    expect(ids(page)).not.toContain(f.userOwnedHolding);
    // …and the default list excludes it as well, so the two agree.
    const dflt = await list(null, { userId: f.ownerId, roles: ['READER'] });
    expect(ids(dflt)).not.toContain(f.userOwnedHolding);
  });

  it('hides the system class by default here too', async () => {
    const dflt = await owned({ userId: f.ownerId, roles: ['READER'] });
    expect(ids(dflt)).not.toContain(f.userOwnedSystem);
    const asked = await owned({ userId: f.ownerId, roles: ['READER'] }, { memoryClasses: ['system'] });
    expect(ids(asked)).toContain(f.userOwnedSystem);
  });

  it('the filter narrows the union rather than replacing it', async () => {
    // Why the two issues ship together: `ownedByMe` returns a SUBSET of the
    // default list. Before #1176 the union had no user-owned rows, so this
    // slice would have been empty for exactly the memories it was asked for —
    // the filter lands with nothing to return, and the reported symptom does
    // not move.
    const over = { userId: f.ownerId, roles: ['READER'] as string[] };
    const dflt = new Set(ids(await list(null, over)));
    const slice = ids(await owned(over));
    expect(slice.length).toBeGreaterThan(0);
    for (const id of slice) expect(dflt.has(id)).toBe(true);
  });
});
