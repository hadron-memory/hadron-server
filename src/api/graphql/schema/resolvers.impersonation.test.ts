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
import { type Context, requireOrgRole, requireEmailConnection, isAppParticipant } from './resolvers.helpers.js';
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

  // #878 — a revoked session must be stamped ended so the audit surface stops
  // reporting it live. `endedBy` stays NULL, which is what distinguishes a
  // system revocation from a person's explicit stop.
  describe('#878 — revocation stamps the audit row', () => {
    /**
     * The stamp is fire-and-forget by design (the request is being rejected
     * regardless, so the write must not add latency to it), which means a
     * test cannot await it directly.
     *
     * POLL for it rather than sleeping a fixed amount. A flat delay is a bet
     * that one unawaited DB write finishes inside it, and on a loaded CI
     * runner — four vitest shards against one Postgres — that bet loses
     * occasionally: this suite went red once on `endedAt` still being null
     * after 100ms, then passed on rerun. Polling is both faster in the normal
     * case and immune to the slow one.
     */
    const waitForEnded = async (sessionId: string, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = await db.impersonationSession.findUnique({ where: { id: sessionId } });
        if (row?.endedAt) return row;
        if (Date.now() > deadline) return row; // let the assertion report it
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    /**
     * For the two NEGATIVE cases below, which assert the row was NOT touched.
     * There is no state change to poll for, so a fixed pause is the only
     * option — and it is safe here: the failure mode is a false PASS, never a
     * false failure.
     */
    const settle = () => new Promise((r) => setTimeout(r, 100));

    it('demoting the admin ends the session, with endedBy null', async () => {
      const { session, token } = await startAsAdmin();
      await db.orgMember.update({
        where: { organizationId_userId: { organizationId: orgA.id, userId: admin.id } },
        data: { role: 'READER' },
      });
      expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
      const row = await waitForEnded(session.id);
      expect(row?.endedAt).not.toBeNull();
      expect(row?.endedBy).toBeNull(); // system revocation, not a person
    });

    it('the revoked session drops out of isActive and the activeOnly filter', async () => {
      const { session, token } = await startAsAdmin();
      await db.orgMember.update({
        where: { organizationId_userId: { organizationId: orgA.id, userId: mike.id } },
        data: { role: 'OWNER' }, // promotion breaches peer-or-below for an ADMIN
      });
      await resolveAuthContext(makeReq(token), db);
      await waitForEnded(session.id);

      const active = await impersonationSessions(
        {},
        { orgId: orgA.id, filter: { activeOnly: true } },
        userCtx(admin),
      );
      expect(active.items.map((s) => s.id)).not.toContain(session.id);

      const row = await db.impersonationSession.findUnique({ where: { id: session.id } });
      expect(row).not.toBeNull(); // fail here, not inside isActive, if it vanished
      const isActiveField = (
        resolvers as unknown as {
          ImpersonationSession: { isActive: (s: unknown) => boolean };
        }
      ).ImpersonationSession.isActive;
      expect(isActiveField(row)).toBe(false);
    });

    // PR #879 review: `payload.sub` is the TARGET on this path, so the generic
    // liveness check in resolveJwt used to short-circuit before the stamp ran.
    it('a deleted TARGET account ends the session (not just the token)', async () => {
      const { session, token } = await startAsAdmin();
      await db.user.update({ where: { id: mike.id }, data: { deletedAt: new Date() } });
      expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
      const row = await waitForEnded(session.id);
      expect(row?.endedAt).not.toBeNull();
      expect(row?.endedBy).toBeNull();
    });

    it('a deleted admin account ends the session too', async () => {
      const { session, token } = await startAsAdmin();
      await db.user.update({ where: { id: admin.id }, data: { deletedAt: new Date() } });
      expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
      const row = await waitForEnded(session.id);
      expect(row?.endedAt).not.toBeNull();
    });

    // The security carve-out: a token whose claims disagree with the row has
    // NOT been shown to belong to it, so presenting one must not be a way to
    // kill somebody else's live session.
    it('a claim/row mismatch does NOT stamp the row', async () => {
      const { session, token } = await startAsAdmin();
      await db.impersonationSession.update({
        where: { id: session.id },
        data: { targetUserId: reader.id }, // row now disagrees with the signed claim
      });
      expect(await resolveAuthContext(makeReq(token), db)).toEqual({});
      await settle();
      const row = await db.impersonationSession.findUnique({ where: { id: session.id } });
      expect(row?.endedAt).toBeNull(); // still live — untouched by the rejected token
    });

    it('does not clobber an explicit stop: endedBy survives a later request', async () => {
      const { session, token, impCtx } = await startAsAdmin();
      await stopImpersonation({}, {}, impCtx);
      const stopped = await db.impersonationSession.findUnique({ where: { id: session.id } });
      expect(stopped?.endedBy).toBe(admin.id);
      // A late request bearing the now-dead token must not overwrite endedAt
      // or blank the actor that the explicit stop recorded.
      await resolveAuthContext(makeReq(token), db);
      await settle();
      const after = await db.impersonationSession.findUnique({ where: { id: session.id } });
      expect(after?.endedAt).toEqual(stopped?.endedAt);
      expect(after?.endedBy).toBe(admin.id);
    });
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
    await expect(memoryQuery({}, { ref: personalMike.id }, impCtx)).resolves.toBeNull();
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

// #876 — the four read-surface bypasses found by the security review, plus
// the class sweep. Each of these resolvers authorizes on ctx.userId as an
// identity/owner and was never reached by the org-scope narrowing; because
// the read-only plugin only inspects MUTATIONS, none were intercepted.
describe('#1094 — isAppParticipant is bounded to the shared org under impersonation', () => {
  // A case per PREDICATE, not per surface. `impersonationSweep.test.ts` has a
  // case per resolver module and did not catch this arm, because the gap was
  // inside a SHARED predicate that several surfaces reach through — the
  // fifth instance of the #876 class, in a predicate written after that sweep.
  let appInSharedOrg: { id: string; organizationId: string | null; ownerUserId: string | null };
  let appInOtherOrg: { id: string; organizationId: string | null; ownerUserId: string | null };
  let userOwnedApp: { id: string; organizationId: string | null; ownerUserId: string | null };
  let impCtx: Context;

  beforeEach(async () => {
    const mkApp = (data: Record<string, unknown>) =>
      db.app.create({ data: { id: generateId(), name: 'a', ...data } as never });
    appInSharedOrg = (await mkApp({ organizationId: orgA.id, urn: 'imp-org-a:app' })) as never;
    appInOtherOrg = (await mkApp({ organizationId: orgB.id, urn: 'imp-org-b:app' })) as never;
    userOwnedApp = (await mkApp({ ownerUserId: mike.id, urn: `${mike.id}:own-app` })) as never;
    // mike is an AppMember of all three. Crucially he is NOT an org
    // CONTRIBUTOR of orgB via the App — he is a member of orgB directly, so
    // the org arm would admit him too; the App used for the negative case
    // therefore has to be judged on the AppMember arm alone, which is why the
    // out-of-scope assertion below ALSO pins the org arm staying closed.
    for (const app of [appInSharedOrg, appInOtherOrg, userOwnedApp]) {
      await db.appMember.create({ data: { appId: app.id, userId: mike.id, role: 'member' } });
    }
    ({ impCtx } = await startAsAdmin());
  });

  it('DENIES an App outside the shared org, even though the target is an AppMember', async () => {
    // The bug: the AppMember arm ran a bare `appMember.findUnique` on
    // ctx.userId, which under impersonation is the TARGET — so it answered a
    // question about the target's memberships anywhere, bypassing the org
    // bound that makes a support session safe.
    expect(await isAppParticipant(impCtx, appInOtherOrg)).toBe(false);
  });

  it('still ADMITS an App inside the shared org — the bound narrows, it does not deny', async () => {
    // The narrowing control, and the reason this is bounded rather than a flat
    // `if (ctx.impersonation) return false`. `requireOrgRole` and
    // `isOrgMemberOrAdmin` both already say "under impersonation only the
    // session's shared org may admit"; this arm now says the same thing. A
    // blanket denial would have been a different rule from the two neighbours.
    expect(await isAppParticipant(impCtx, appInSharedOrg)).toBe(true);
  });

  it('DENIES a user-owned App under impersonation (unchanged, and for a different reason)', async () => {
    // The owner arm denies outright — not because identity-scoped things are
    // always denied, but because a user-owned App has NO org, so it can never
    // satisfy a shared-org bound. Same rule, degenerate case.
    expect(await isAppParticipant(impCtx, userOwnedApp)).toBe(false);
  });

  it('appNodes gives a support session the IN-SCOPE team space, and not the out-of-scope one', async () => {
    // PR #1107 review, @codex P2. Fixing the predicate made a caller-level veto
    // obsolete: `appNodes` set `participant = !ctx.impersonation && …` as a #1093
    // stopgap, which denied the arm for IN-SCOPE sessions too — a support
    // session lost the team chat, worklog and epics of an App inside the very
    // org it was scoped to, while the dedicated surfaces admitted them.
    //
    // This asserts the pair, because removing a veto is only correct if the
    // thing underneath it still refuses: in-scope team space visible,
    // out-of-scope App refused outright.
    const mkTeamSpace = async (app: { id: string }, orgId: string, slug: string) => {
      // `sharedMemoryOfAgentId` is what makes this row RECOGNISABLE as the
      // App's team space (the #723 "adopted" key). Without it
      // resolveAppTeamSpaceMemoryIds falls through to the legacy arm, which
      // recognises a row by its URN shape — so a plainly-named fixture is not a
      // team space at all, and the assertion below would have failed for a
      // reason that has nothing to do with impersonation.
      const agent = await db.agent.create({
        data: { id: generateId(), organizationId: orgId, urn: `${slug}:ag-${generateId().slice(-6)}`, name: 'ag' } as never,
      });
      const mem = await db.memory.create({
        data: {
          id: generateId(), organizationId: orgId, appId: app.id,
          sharedMemoryOfAgentId: agent.id,
          urn: `${slug}:team`, name: `${slug}-team`, class: 'app',
        } as never,
      });
      await db.node.create({
        data: { id: generateId(), memoryId: mem.id, loc: `chats:team`, name: 'team chat', tags: [] },
      });
      return mem;
    };
    await mkTeamSpace(appInSharedOrg, orgA.id, 'imp-org-a');
    await mkTeamSpace(appInOtherOrg, orgB.id, 'imp-org-b');

    const appNodes = resolvers.Query.appNodes as (
      p: unknown, a: { appRef: string }, c: Context,
    ) => Promise<{ loc: string }[]>;

    const inScope = await appNodes({}, { appRef: appInSharedOrg.id }, impCtx);
    expect(inScope.map((n) => n.loc)).toContain('chats:team');

    // The out-of-scope App is refused entirely — the org bound, not merely a
    // narrower scope.
    await expect(appNodes({}, { appRef: appInOtherOrg.id }, impCtx)).rejects.toThrow();
  });

  it('the bound is impersonation-specific: mike himself is still a participant everywhere', async () => {
    // Without this, a fix that simply denied the AppMember arm would pass every
    // assertion above while breaking ordinary participation.
    const mikeCtx = { db, userId: mike.id, roles: ['READER'] } as Context;
    expect(await isAppParticipant(mikeCtx, appInOtherOrg)).toBe(true);
    expect(await isAppParticipant(mikeCtx, appInSharedOrg)).toBe(true);
    expect(await isAppParticipant(mikeCtx, userOwnedApp)).toBe(true);
  });
});

describe('#876 — identity-scoped read surfaces are denied under impersonation', () => {
  let impCtx: Context;

  beforeEach(async () => {
    ({ impCtx } = await startAsAdmin());
  });

  const q = (name: string) =>
    resolvers.Query[name as keyof typeof resolvers.Query] as never as (
      p: unknown,
      a: Record<string, unknown>,
      c: Context,
    ) => Promise<unknown>;

  it('1. mail/calendar/Drive: requireEmailConnection refuses (nine query fields)', async () => {
    const conn = await db.exchangeConnection.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        userId: mike.id, // the TARGET owns this mailbox
        provider: 'gmail',
        mailboxEmail: 'mike@x.io',
        toolConnectionId: 'tool-conn-1',
      },
    });
    // The owner branch would otherwise admit: ctx.userId IS conn.userId.
    await expect(requireEmailConnection(impCtx, conn.id, 'list-messages')).rejects.toThrow(
      /Forbidden/,
    );
    // ...and the same call as mike himself still works (no collateral damage).
    await expect(
      requireEmailConnection(userCtx(mike), conn.id, 'list-messages'),
    ).resolves.toMatchObject({ id: conn.id });
  });

  it('2. chats: myChats and chatHistory refuse', async () => {
    await expect(q('myChats')({}, { agentRef: 'whatever' }, impCtx)).rejects.toThrow(/Forbidden/);
    await expect(q('chatHistory')({}, { chatId: 'whatever' }, impCtx)).rejects.toThrow(/Forbidden/);
  });

  it('3. assets: listing and the presigned download URL refuse', async () => {
    await expect(q('memoryAssets')({}, { memoryId: 'whatever' }, impCtx)).rejects.toThrow(
      /Forbidden/,
    );
    await expect(
      q('assetDownloadUrl')({}, { assetId: 'whatever', ttlSeconds: 3600 }, impCtx),
    ).rejects.toThrow(/Forbidden/);
    await expect(q('agentAssets')({}, { agentId: 'whatever' }, impCtx)).rejects.toThrow(
      /Forbidden/,
    );
  });

  it('4. agents/apps lists omit the target user-owned rows — default view AND ownedByMe', async () => {
    const ownedAgent = await db.agent.create({
      data: { id: generateId(), name: 'mike-private', ownerUserId: mike.id, urn: 'imp-mike:agent' },
    });
    const ownedApp = await db.app.create({
      data: { id: generateId(), name: 'mike-app', ownerUserId: mike.id, urn: 'imp-mike:app' },
    });
    // Baseline: mike sees his own in BOTH views.
    const mineAgents = (await q('agents')({}, {}, userCtx(mike))) as { items: { id: string }[] };
    expect(mineAgents.items.map((a) => a.id)).toContain(ownedAgent.id);
    const mineApps = (await q('apps')({}, {}, userCtx(mike))) as { items: { id: string }[] };
    expect(mineApps.items.map((a) => a.id)).toContain(ownedApp.id);

    // Impersonated: absent from the default view (the leak did NOT need the
    // ownedByMe filter — an unfiltered list is what the portal issues)...
    for (const [field, id] of [
      ['agents', ownedAgent.id],
      ['apps', ownedApp.id],
    ] as const) {
      const def = (await q(field)({}, {}, impCtx)) as { items: { id: string }[] };
      expect(def.items.map((r) => r.id)).not.toContain(id);
      const owned = (await q(field)({}, { filter: { ownedByMe: true } }, impCtx)) as {
        items: { id: string }[];
        total: number;
      };
      expect(owned.total).toBe(0);
    }
  });

  it('class sweep: other identity-scoped surfaces are denied or empty', async () => {
    // Cross-org / personal inventories.
    await expect(q('myUserApiKeys')({}, {}, impCtx)).rejects.toThrow(/Forbidden/);
    await expect(q('myAgentSubscriptions')({}, {}, impCtx)).resolves.toEqual([]);
    await expect(q('usageActivity')({}, {}, impCtx)).resolves.toEqual([]);
    await expect(q('dashboardWidgets')({}, {}, impCtx)).resolves.toEqual([]);
    await expect(q('dashboardWidgetPresets')({}, {}, impCtx)).resolves.toEqual([]);
    // Delegated-access inventories (org-unconstrained, identity-keyed).
    await expect(q('connectionGrants')({}, {}, impCtx)).resolves.toMatchObject({ total: 0 });
    await expect(q('principalGrants')({}, {}, impCtx)).resolves.toMatchObject({ total: 0 });
    // The audit surface is administrative, not part of the impersonated view.
    await expect(q('impersonationSessions')({}, { orgId: orgA.id }, impCtx)).rejects.toThrow(
      /Forbidden/,
    );
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
