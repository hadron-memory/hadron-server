/**
 * Admin impersonation (read-only, shared-org-scoped support sessions).
 *
 * Covers the contract end to end at the resolver/middleware layer:
 *   - start gates (org role, peer-or-below, platform admin, liveness, self);
 *   - stop paths (self-stop under the imp token, by-id, idempotency, endedBy);
 *   - resolveAuthContext for imp tokens (row revalidation: ended / expired /
 *     demoted admin / removed target / claim-row mismatch — all resolve {});
 *   - the read-only Apollo plugin (mutations blocked, stopImpersonation +
 *     queries allowed, fragments/aliases can't smuggle);
 *   - THE ORG-SCOPE SUITE: the impersonated context sees only what the
 *     target sees within the shared org — other orgs and every
 *     identity-scoped resource (personal/private, user-owned, shares)
 *     are invisible;
 *   - authContext exposure + the audit list gates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parse, type DocumentNode, type OperationDefinitionNode } from 'graphql';
import type { Request } from 'express';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolveAuthContext, type AuthContext } from '../../../middleware/auth.js';
import { resolvers } from './resolvers.js';
import { type Context, requireOrgRole } from './resolvers.helpers.js';
import { canSeeUserPersonalFields } from '../../../lib/auth/userVisibility.js';
import { impersonationReadOnlyPlugin } from '../impersonationReadOnlyPlugin.js';

// JWT_SECRET is set in vitest.config.ts env.

type StartResult = { session: { id: string; expiresAt: Date; reason: string | null }; token: string };

const startImpersonation = resolvers.Mutation.startImpersonation as (
  p: unknown,
  a: { orgRef: string; userRef: string; reason?: string | null },
  c: Context,
) => Promise<StartResult>;
const stopImpersonation = resolvers.Mutation.stopImpersonation as (
  p: unknown,
  a: { id?: string | null },
  c: Context,
) => Promise<{ id: string; endedAt: Date | null; endedBy: string | null }>;
const impersonationSessions = resolvers.Query.impersonationSessions as (
  p: unknown,
  a: Record<string, unknown>,
  c: Context,
) => Promise<{ items: { id: string }[]; total: number }>;
const authContextQuery = resolvers.Query.authContext as (
  p: unknown,
  a: unknown,
  c: Context,
) => Promise<{ impersonation: { sessionId: string; readOnly: boolean } | null } | null>;

let orgA: { id: string };
let orgB: { id: string };
let admin: { id: string };   // org-A ADMIN
let ownerA: { id: string };  // org-A OWNER
let reader: { id: string };  // org-A READER
let mike: { id: string };    // target: member of A and B
let platformAdmin: { id: string }; // platform ADMIN, member of nothing

const userCtx = (u: { id: string }, roles: AuthContext['roles'] = []): Context =>
  ({ db, userId: u.id, roles }) as Context;

function makeReq(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

/** Start a session as org-A admin targeting mike; return {session, token, ctx-from-token}. */
async function startAsAdmin(): Promise<StartResult & { impCtx: Context }> {
  const result = await startImpersonation(
    {},
    { orgRef: orgA.id, userRef: mike.id, reason: 'support ticket 42' },
    userCtx(admin),
  );
  const auth = await resolveAuthContext(makeReq(result.token), db);
  expect(auth.userId).toBe(mike.id); // sanity: the token resolves before each scenario
  return { ...result, impCtx: { db, ...auth } as Context };
}

beforeEach(async () => {
  await cleanDb(db);
  const mkUser = (handle: string, roles: string[] = ['READER']) =>
    db.user.create({ data: { id: generateId(), handle, name: handle, email: `${handle}@x.io`, roles: roles as never } });
  admin = await mkUser('impadmin');
  ownerA = await mkUser('impowner');
  reader = await mkUser('impreader');
  mike = await mkUser('impmike');
  platformAdmin = await mkUser('impplatform', ['ADMIN']);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'Org A', urn: 'imp-org-a' } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'Org B', urn: 'imp-org-b' } });
  const mkMember = (org: { id: string }, u: { id: string }, role: string) =>
    db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: role as never } });
  await mkMember(orgA, admin, 'ADMIN');
  await mkMember(orgA, ownerA, 'OWNER');
  await mkMember(orgA, reader, 'READER');
  await mkMember(orgA, mike, 'CONTRIBUTOR');
  await mkMember(orgB, mike, 'CONTRIBUTOR');
});

describe('startImpersonation gates', () => {
  it('org ADMIN may impersonate a CONTRIBUTOR co-member', async () => {
    const { session, token } = await startAsAdmin();
    expect(token).toMatch(/^eyJ/);
    expect(session.reason).toBe('support ticket 42');
    const row = await db.impersonationSession.findUnique({ where: { id: session.id } });
    expect(row?.adminUserId).toBe(admin.id);
    expect(row?.targetUserId).toBe(mike.id);
    expect(row?.organizationId).toBe(orgA.id);
  });

  it('READER and CONTRIBUTOR are denied', async () => {
    await expect(
      startImpersonation({}, { orgRef: orgA.id, userRef: mike.id }, userCtx(reader)),
    ).rejects.toThrow(/Forbidden/);
  });

  it('cross-org admin is denied (no shared-org authority)', async () => {
    // admin administers org A only; naming org B fails even though mike is a member there.
    await expect(
      startImpersonation({}, { orgRef: orgB.id, userRef: mike.id }, userCtx(admin)),
    ).rejects.toThrow(/Forbidden/);
  });

  it('peer-or-below: an org ADMIN may NOT impersonate an org OWNER', async () => {
    await expect(
      startImpersonation({}, { orgRef: orgA.id, userRef: ownerA.id }, userCtx(admin)),
    ).rejects.toThrow(/Forbidden/);
  });

  it('an org OWNER may impersonate another OWNER', async () => {
    const secondOwner = await db.user.create({ data: { id: generateId(), handle: 'impowner2' } });
    await db.orgMember.create({ data: { organizationId: orgA.id, userId: secondOwner.id, role: 'OWNER' } });
    const r = await startImpersonation({}, { orgRef: orgA.id, userRef: secondOwner.id }, userCtx(ownerA));
    expect(r.token).toBeTruthy();
  });

  it('a platform admin (non-member) may impersonate, OWNER-equivalent', async () => {
    const r = await startImpersonation(
      {},
      { orgRef: orgA.id, userRef: ownerA.id },
      userCtx(platformAdmin, ['ADMIN']),
    );
    expect(r.token).toBeTruthy();
  });

  it('self-impersonation is rejected', async () => {
    await expect(
      startImpersonation({}, { orgRef: orgA.id, userRef: admin.id }, userCtx(admin)),
    ).rejects.toThrow(/yourself/);
  });

  it('a non-member target is rejected', async () => {
    const outsider = await db.user.create({ data: { id: generateId(), handle: 'impoutsider' } });
    await expect(
      startImpersonation({}, { orgRef: orgA.id, userRef: outsider.id }, userCtx(admin)),
    ).rejects.toThrow(/not an active member/);
  });

  it('a revoked (soft-deleted) target membership is rejected', async () => {
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgA.id, userId: mike.id } },
      data: { deletedAt: new Date() },
    });
    await expect(
      startImpersonation({}, { orgRef: orgA.id, userRef: mike.id }, userCtx(admin)),
    ).rejects.toThrow(/not an active member/);
  });

  it('an impersonated context cannot start a nested session', async () => {
    const { impCtx } = await startAsAdmin();
    await expect(
      startImpersonation({}, { orgRef: orgA.id, userRef: reader.id }, impCtx),
    ).rejects.toThrow(/Forbidden/);
  });

  it('respects IMPERSONATION_TTL_SECONDS (clamped)', async () => {
    process.env.IMPERSONATION_TTL_SECONDS = '120';
    try {
      const before = Date.now();
      const { session } = await startAsAdmin();
      const ttlMs = new Date(session.expiresAt).getTime() - before;
      expect(ttlMs).toBeGreaterThan(100_000);
      expect(ttlMs).toBeLessThan(140_000);
    } finally {
      delete process.env.IMPERSONATION_TTL_SECONDS;
    }
  });
});

describe('impersonation token resolution (middleware)', () => {
  it('resolves to the target with roles [] and the impersonation context set', async () => {
    const { session, token } = await startAsAdmin();
    const auth = await resolveAuthContext(makeReq(token), db);
    expect(auth.userId).toBe(mike.id);
    expect(auth.roles).toEqual([]);
    expect(auth.impersonation).toMatchObject({
      sessionId: session.id,
      actorUserId: admin.id,
      orgId: orgA.id,
    });
  });

  it('never inherits the target platform roles', async () => {
    await db.user.update({ where: { id: mike.id }, data: { roles: ['ADMIN'] } });
    const { token } = await startAsAdmin();
    const auth = await resolveAuthContext(makeReq(token), db);
    expect(auth.roles).toEqual([]);
  });

  it('an ended session no longer authenticates', async () => {
    const { session, token } = await startAsAdmin();
    await stopImpersonation({}, { id: session.id }, userCtx(admin));
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });

  it('an expired session no longer authenticates', async () => {
    const { session, token } = await startAsAdmin();
    await db.impersonationSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });

  it('demoting the admin kills the token', async () => {
    const { token } = await startAsAdmin();
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgA.id, userId: admin.id } },
      data: { role: 'READER' },
    });
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });

  it('removing the target from the org kills the token', async () => {
    const { token } = await startAsAdmin();
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgA.id, userId: mike.id } },
      data: { deletedAt: new Date() },
    });
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });

  // PR #875 review (both reviewers): peer-or-below was checked only at mint,
  // so a role change mid-session left the token valid in a combination the
  // start-time rule forbids. The rule is now re-applied per request.
  it('promoting the target to OWNER kills an ADMIN-started token', async () => {
    const { token } = await startAsAdmin(); // admin (org ADMIN) impersonating mike (CONTRIBUTOR)
    expect((await resolveAuthContext(makeReq(token), db)).userId).toBe(mike.id);
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgA.id, userId: mike.id } },
      data: { role: 'OWNER' },
    });
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });

  it('demoting an OWNER actor to ADMIN kills a token that targets an OWNER', async () => {
    const secondOwner = await db.user.create({ data: { id: generateId(), handle: 'impowner3' } });
    await db.orgMember.create({
      data: { organizationId: orgA.id, userId: secondOwner.id, role: 'OWNER' },
    });
    // ownerA (OWNER) may impersonate another OWNER.
    const { token } = await startImpersonation(
      {},
      { orgRef: orgA.id, userRef: secondOwner.id },
      userCtx(ownerA),
    ).then(async (r) => ({ token: r.token }));
    expect((await resolveAuthContext(makeReq(token), db)).userId).toBe(secondOwner.id);
    // Demote the actor to ADMIN — an ADMIN may not impersonate an OWNER.
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgA.id, userId: ownerA.id } },
      data: { role: 'ADMIN' },
    });
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });

  it('a claim/row mismatch resolves empty (token cannot repoint a session)', async () => {
    const { session, token } = await startAsAdmin();
    // Repoint the ROW at a different target; the signed claim still names mike.
    await db.impersonationSession.update({
      where: { id: session.id },
      data: { targetUserId: reader.id },
    });
    expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
  });
});

describe('stopImpersonation', () => {
  it('self-stop under the imp token records the ADMIN as endedBy', async () => {
    const { session, impCtx } = await startAsAdmin();
    const stopped = await stopImpersonation({}, {}, impCtx);
    expect(stopped.id).toBe(session.id);
    expect(stopped.endedAt).not.toBeNull();
    expect(stopped.endedBy).toBe(admin.id); // never mike (the target)
  });

  it('the admin can stop by id with a normal token; idempotent on re-stop', async () => {
    const { session } = await startAsAdmin();
    const first = await stopImpersonation({}, { id: session.id }, userCtx(admin));
    expect(first.endedAt).not.toBeNull();
    const second = await stopImpersonation({}, { id: session.id }, userCtx(admin));
    expect(second.endedAt).toEqual(first.endedAt);
  });

  it('an unrelated org member cannot stop it', async () => {
    const { session } = await startAsAdmin();
    await expect(stopImpersonation({}, { id: session.id }, userCtx(reader))).rejects.toThrow(
      /Forbidden/,
    );
  });

  it('an org OWNER (not the actor) can stop it', async () => {
    const { session } = await startAsAdmin();
    const stopped = await stopImpersonation({}, { id: session.id }, userCtx(ownerA));
    expect(stopped.endedBy).toBe(ownerA.id);
  });
});

describe('read-only plugin', () => {
  async function runPlugin(doc: DocumentNode, impersonated: boolean): Promise<Error | null> {
    const listener = await impersonationReadOnlyPlugin.requestDidStart!({} as never);
    const operation = doc.definitions.find(
      (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
    );
    try {
      await listener!.didResolveOperation!({
        operation,
        document: doc,
        contextValue: impersonated
          ? { impersonation: { sessionId: 's', actorUserId: 'a', orgId: 'o', expiresAt: new Date() } }
          : {},
      } as never);
      return null;
    } catch (e) {
      return e as Error;
    }
  }

  it('blocks an arbitrary mutation for an impersonated context', async () => {
    const err = await runPlugin(parse('mutation { createMemory(name: "x") { id } }'), true);
    expect(err?.message).toMatch(/read-only impersonation/);
  });

  it('an alias does not hide the real field', async () => {
    const err = await runPlugin(parse('mutation { stop: createMemory(name: "x") { id } }'), true);
    expect(err).not.toBeNull();
  });

  it('a fragment on Mutation cannot smuggle a field', async () => {
    const doc = parse(
      'mutation { ...f } fragment f on Mutation { createMemory(name: "x") { id } }',
    );
    expect(await runPlugin(doc, true)).not.toBeNull();
  });

  it('allows stopImpersonation and queries; non-impersonated requests unaffected', async () => {
    expect(await runPlugin(parse('mutation { stopImpersonation { id } }'), true)).toBeNull();
    expect(await runPlugin(parse('query { me { id } }'), true)).toBeNull();
    expect(await runPlugin(parse('mutation { createMemory(name: "x") { id } }'), false)).toBeNull();
  });

  // PR #875 review (both reviewers, independently): the depth guard returned
  // an EMPTY list past the limit, which the caller read as "zero blocked
  // fields" — so a mutation hidden behind deep nesting executed. Traversal
  // must fail CLOSED.
  it('blocks a mutation hidden behind nesting deeper than the traversal limit', async () => {
    // 80 nested inline fragments — legal GraphQL, past MAX_SELECTION_DEPTH (64).
    const depth = 80;
    const doc = parse(
      `mutation { ${'... on Mutation { '.repeat(depth)}createMemory(name: "x") { id }${' }'.repeat(depth)} }`,
    );
    const err = await runPlugin(doc, true);
    expect(err?.message).toMatch(/read-only impersonation/);
  });

  it('blocks when a fragment spread names an unknown fragment', async () => {
    // Can't enumerate what the spread selects ⇒ cannot prove it is safe.
    expect(await runPlugin(parse('mutation { ...missingFragment }'), true)).not.toBeNull();
  });

  it('still allows two sibling spreads of the same fragment (not a cycle)', async () => {
    const doc = parse(
      'mutation { ...s ...s } fragment s on Mutation { stopImpersonation { id } }',
    );
    expect(await runPlugin(doc, true)).toBeNull();
  });
});

describe('org-scope: the impersonated context sees only the shared org', () => {
  let knowledgeA: { id: string };
  let knowledgeB: { id: string };
  let personalMike: { id: string };
  let userOwnedMike: { id: string };
  let sharedWithMike: { id: string };
  let impCtx: Context;

  beforeEach(async () => {
    const mkMemory = (data: Record<string, unknown>) =>
      db.memory.create({ data: { id: generateId(), name: 'm', ...data } as never });
    knowledgeA = await mkMemory({ organizationId: orgA.id, urn: 'imp-org-a:ka', class: 'knowledge' });
    knowledgeB = await mkMemory({ organizationId: orgB.id, urn: 'imp-org-b:kb', class: 'knowledge' });
    // Free-standing personal memory owned by mike (spec 034; org-XOR-owner
    // requires the tenant axis, so ownerUserId doubles with the strict owner).
    personalMike = await mkMemory({
      urn: 'imp-mike:personal', class: 'personal', userId: mike.id, ownerUserId: mike.id,
    });
    // Spec-047 user-owned (tenant) memory of mike's.
    userOwnedMike = await mkMemory({ urn: 'imp-mike:owned', class: 'knowledge', ownerUserId: mike.id });
    // A personal memory of reader's, shared WITH mike (grantee).
    sharedWithMike = await mkMemory({
      urn: 'imp-reader:shared', class: 'personal', userId: reader.id, ownerUserId: reader.id,
    });
    await db.memoryShare.create({
      data: { memoryId: sharedWithMike.id, granteeId: mike.id, grantorId: reader.id, role: 'reader' },
    });
    ({ impCtx } = await startAsAdmin());
  });

  it('baseline: mike himself lists both org memories AND his personal memory', async () => {
    // (user-owned and shared-with-me rows live in their own slices/filters,
    // not the default union — the baseline pins what impersonation must trim.)
    const page = await (resolvers.Query.memories as never as (
      p: unknown, a: Record<string, unknown>, c: Context,
    ) => Promise<{ items: { id: string }[] }>)({}, {}, userCtx(mike));
    const ids = page.items.map((m) => m.id);
    for (const m of [knowledgeA, knowledgeB, personalMike]) {
      expect(ids).toContain(m.id);
    }
  });

  it('memories: only org-A knowledge; org-B, personal, user-owned, shared all invisible', async () => {
    const page = await (resolvers.Query.memories as never as (
      p: unknown, a: Record<string, unknown>, c: Context,
    ) => Promise<{ items: { id: string }[] }>)({}, {}, impCtx);
    const ids = page.items.map((m) => m.id);
    expect(ids).toContain(knowledgeA.id);
    expect(ids).not.toContain(knowledgeB.id);
    expect(ids).not.toContain(personalMike.id);
    expect(ids).not.toContain(userOwnedMike.id);
    expect(ids).not.toContain(sharedWithMike.id);
  });

  it('Query.memory denies the target own personal memory', async () => {
    const memoryQuery = resolvers.Query.memory as never as (
      p: unknown, a: { ref: string }, c: Context,
    ) => Promise<unknown>;
    await expect(memoryQuery({}, { ref: personalMike.id }, impCtx)).rejects.toThrow();
    // ...but resolves the shared-org knowledge memory.
    const ok = await memoryQuery({}, { ref: knowledgeA.id }, impCtx);
    expect((ok as { id: string }).id).toBe(knowledgeA.id);
  });

  it('organizations list collapses to the shared org', async () => {
    const page = await (resolvers.Query.organizations as never as (
      p: unknown, a: Record<string, unknown>, c: Context,
    ) => Promise<{ items: { id: string }[] }>)({}, { filter: { memberOnly: true } }, impCtx);
    const ids = page.items.map((o) => o.id);
    expect(ids).toContain(orgA.id);
    expect(ids).not.toContain(orgB.id);
  });

  it('a named-org gate for the other org throws Forbidden', async () => {
    // mike IS a live member of org B; the impersonated context must still be refused.
    await expect(requireOrgRole(impCtx, orgB.id, 'READER')).rejects.toThrow(/Forbidden/);
    await expect(requireOrgRole(impCtx, orgA.id, 'READER')).resolves.toBeUndefined();
  });

  it('user visibility: co-members of the OTHER org are strangers', async () => {
    const bOnly = await db.user.create({
      data: { id: generateId(), handle: 'imp-b-only', name: 'B Only', email: 'b@x.io' },
    });
    await db.orgMember.create({ data: { organizationId: orgB.id, userId: bOnly.id, role: 'READER' } });
    // mike himself sees the org-B co-member's name/email...
    expect(await canSeeUserPersonalFields(userCtx(mike), bOnly.id)).toBe(true);
    // ...the impersonated context does not (co-membership judged in org A only)...
    expect(await canSeeUserPersonalFields(impCtx, bOnly.id)).toBe(false);
    // ...while an org-A co-member stays visible.
    expect(await canSeeUserPersonalFields(impCtx, reader.id)).toBe(true);
  });

  it('effectiveAccess refuses out-of-scope and identity-scoped resources', async () => {
    const effectiveAccess = resolvers.Query.effectiveAccess as never as (
      p: unknown, a: { user: string; resource: string }, c: Context,
    ) => Promise<unknown>;
    // Out-of-org resource — even a self-audit (subject = target) is refused.
    await expect(
      effectiveAccess({}, { user: mike.id, resource: 'hrn:mem:imp-org-b:kb' }, impCtx),
    ).rejects.toThrow(/Forbidden/);
    // The target's own personal memory is identity-scoped — refused.
    await expect(
      effectiveAccess({}, { user: mike.id, resource: 'hrn:mem:imp-mike:personal' }, impCtx),
    ).rejects.toThrow(/Forbidden/);
    // In-org resource — allowed.
    await expect(
      effectiveAccess({}, { user: mike.id, resource: 'hrn:mem:imp-org-a:ka' }, impCtx),
    ).resolves.toBeTruthy();
  });
});

describe('authContext + audit list', () => {
  it('authContext exposes the impersonation facts', async () => {
    const { session, impCtx } = await startAsAdmin();
    const result = await authContextQuery({}, {}, impCtx);
    expect(result?.impersonation).toMatchObject({ sessionId: session.id, readOnly: true });
  });

  it('authContext.impersonation is null for a normal session', async () => {
    const result = await authContextQuery({}, {}, userCtx(admin));
    expect(result?.impersonation).toBeNull();
  });

  it('org admins list their org sessions; members are refused; platform admin unscoped', async () => {
    const { session } = await startAsAdmin();
    const forAdmin = await impersonationSessions({}, { orgId: orgA.id }, userCtx(admin));
    expect(forAdmin.items.map((s) => s.id)).toContain(session.id);
    await expect(impersonationSessions({}, { orgId: orgA.id }, userCtx(reader))).rejects.toThrow(
      /Forbidden/,
    );
    await expect(impersonationSessions({}, {}, userCtx(reader))).rejects.toThrow(/orgId is required/);
    const forPlatform = await impersonationSessions({}, {}, userCtx(platformAdmin, ['ADMIN']));
    expect(forPlatform.total).toBeGreaterThan(0);
  });

  it('activeOnly filters out stopped sessions', async () => {
    const { session } = await startAsAdmin();
    await stopImpersonation({}, { id: session.id }, userCtx(admin));
    const active = await impersonationSessions(
      {},
      { orgId: orgA.id, filter: { activeOnly: true } },
      userCtx(admin),
    );
    expect(active.items.map((s) => s.id)).not.toContain(session.id);
  });
});
