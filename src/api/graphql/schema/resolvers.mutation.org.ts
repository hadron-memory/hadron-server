import { transportRateIdentity } from '../../../lib/rateLimit/identity.js';
// orgMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { GraphQLError } from 'graphql';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { parsePolicyLink } from '@hadron-memory/access-control';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import {
  normalizeHandle,
  normalizeHandleOrNull,
  generateUniqueHandle,
} from '../../../lib/userHandle.js';
import { propagateOrgUrnRename } from '../../../lib/org/propagateOrgUrnRename.js';
import { renameOwnerNamespacedUrns } from '../../../lib/ownerUrnRename.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';
import { beginUserMergeConsent, approveUserMergeConsent } from '../../../lib/userMergeConsent.js';
import {
  deleteUserAccount,
  SoleOrgOwnerError,
} from '../../../controller/operations/deleteUser.js';
import { softDeleteOrganizationCore } from '../../../controller/operations/softDeleteOrganization.js';
import { validateOrgRoot } from '../../../lib/org/orgRoot.js';
import { retryOnSerializationFailure } from '../../../lib/serializableRetry.js';
import {
  mintPrincipal,
  releasePrincipal,
  ensureUserPrincipal,
  RootNameTakenError,
} from '../../../lib/principal/mintPrincipal.js';
import {
  Prisma,
  type Role,
} from '../../../generated/prisma/index.js';
import {
  type Context,
  isPlatformAdmin,
  requireRole,
  requireOrgRole,
  resolveUserRefArg,
  resolveOrgRefArg,
  ORG_INCLUDE,
} from './resolvers.helpers.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { isUniqueViolationOn, HANDLE_TARGETS } from '../../../auth/userProvision.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { AuthoritySnapshotStale } from '../../../lib/auth/authorityAnchors.js';
import { assertIssuerInvitationSnapshotFresh, revokeOrgInvitationsByIssuer } from '../../../lib/auth/revokeOrgInvitations.js';
import { unauthenticatedError } from '../../../lib/refusals.js';
import { forbiddenError } from '../../../lib/refusals.js';
import { assertInviteLimits, inviteExpiresAt, inviteMaxActivations } from '../../../lib/invitationLimits.js';

/** #2871: expected org-member refusals are typed so the boundary does not mask them. */
const orgMemberRefusal = (code: 'CONFLICT' | 'NOT_FOUND', message: string) =>
  new GraphQLError(message, { extensions: { code } });

/** #2867: acceptInvitation's typed refusals, so the boundary does not mask them. */
const invitationNotFound = () =>
  new GraphQLError('Invitation not found', { extensions: { code: 'NOT_FOUND' } });
const invitationRevoked = () =>
  new GraphQLError('Invitation has been revoked', { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Map a `RootNameTakenError` from the #692 principal pool to a user-facing
 * conflict; re-throw anything else. Use as a `.catch()` on a mint transaction.
 */
function rethrowRootNameTaken(err: unknown): never {
  if (err instanceof RootNameTakenError) {
    throw new GraphQLError(`The name "${err.rootName}" is already taken.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  throw err;
}

export const orgMutations = {
    updateMyProfile: async (
      _: unknown,
      { name, handle, email }: { name?: string; handle?: string | null; email?: string | null },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      // A handle is the hrn:user:<handle> slug — normalize to lowercase-canonical
      // and validate (#325). `undefined` leaves it unchanged; an illegal handle
      // throws. spec 047: handle is NOT NULL, so it can no longer be cleared —
      // an explicit null/empty is a BAD_USER_INPUT rather than a silent null.
      let handleData: { handle?: string } = {};
      if (handle !== undefined) {
        if (!handle || handle.trim() === '') {
          throw new GraphQLError('handle is required and cannot be cleared.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        handleData = { handle: normalizeHandle(handle) };
      }
      const newHandle = handleData.handle;
      // spec 047: a handle change re-namespaces every user-owned entity URN
      // (`@<old>:…` → `@<new>:…`). Do the User update + the URN propagation in
      // ONE transaction so a handle can never diverge from the URNs that embed
      // it (a half-rename would orphan `@<old>:…` App/Agent/Memory URNs).
      const userId = ctx.userId;
      return ctx.db
        .$transaction(async (tx) => {
          // Lock the user row FOR UPDATE before reading the current handle, so a
          // concurrent updateMyProfile can't let us read a stale handle and then
          // skip / mis-target the propagation (gemini review, #686 — mirrors the
          // org-rename lock). A plain SELECT would not serialize the two writers.
          const locked = await tx.$queryRaw<{ handle: string | null; principal_id: string | null; email: string | null }[]>`
            SELECT handle, principal_id, email FROM users WHERE id = ${userId} FOR UPDATE
          `;
          if (locked.length === 0) throw unauthenticatedError();
          const current = locked[0];
          // Identity addresses require proof of control. Profile edits cannot
          // establish or replace one; an unchanged form field is a no-op.
          if (email !== undefined && (email?.trim().toLowerCase() || null) !== (current.email?.trim().toLowerCase() || null)) {
            throw new GraphQLError('Email changes require verification and cannot be made through profile updates.', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          // `normalizeHandleOrNull` on the stored handle is a defensive no-op
          // (already normalized) that also yields the null oldHandle the
          // propagation uses to skip the entry_node_urn rewrites.
          const oldHandle = normalizeHandleOrNull(current.handle);
          const renaming = !!newHandle && newHandle !== oldHandle;
          // #692: on a handle change, mint the NEW root's principal first
          // (fail-safe), tombstone the OLD name, and re-point the user.
          let principalData: { principalId?: string } = {};
          if (renaming) {
            const principal = await mintPrincipal(tx, { kind: 'user', name: newHandle });
            if (current.principal_id) await releasePrincipal(tx, current.principal_id);
            principalData = { principalId: principal.id };
          }
          // #2868: the pool mint above only sees REGISTERED owners. A User whose
          // `principal_id` is NULL still holds its handle through the
          // `users_handle_lower_uniq` functional index, so that collision
          // surfaces here as P2002 — translate it to the same RootNameTakenError
          // (and so the same refusal text) a registered owner yields. The
          // transaction rolls back whole: the mint and the release above leave
          // no trace, and the unregistered owner's handle is not touched.
          let updated;
          try {
            updated = await tx.user.update({
              where: { id: userId },
              data: {
                ...(name !== undefined ? { name } : {}),
                ...handleData,
                ...principalData,
              },
            });
          } catch (err) {
            if (renaming && newHandle && isUniqueViolationOn(err, HANDLE_TARGETS)) throw new RootNameTakenError(newHandle);
            throw err;
          }
          // Propagate only when the handle actually changed — the rewrite is
          // FK-scoped + idempotent, so this guard is just churn avoidance.
          if (renaming) {
            await renameOwnerNamespacedUrns(tx, userId, oldHandle, newHandle);
          }
          return updated;
        })
        .catch(rethrowRootNameTaken);
    },

    updateUserRoles: async (
      _: unknown,
      { userId, roles }: { userId: string; roles: Role[] },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return withAuthorizedTx(
        ctx,
        [{ kind: 'user', id: userId }],
        async (txCtx) => { requireRole(txCtx, 'ADMIN'); },
        (tx) => tx.user.update({ where: { id: userId }, data: { roles } }),
        {
          lockMode: 'exclusive',
          afterLock: async (tx) => {
            // The actor's role was already read under FOR SHARE. Upgrade only
            // the target row: upgrading a shared actor row in two unrelated
            // role changes could deadlock the two transactions.
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
          },
        },
      );
    },

    beginMergeUsersConsent: async (_: unknown, { source, target }: { source: string; target: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      if (!ctx.userId || ctx.apiKeyId || ctx.sessionId || ctx.impersonation || ctx.appId) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
      const [s, t] = await Promise.all([resolveUserRef(ctx.db, source), resolveUserRef(ctx.db, target)]);
      return beginUserMergeConsent(ctx.db, s.id, t.id, ctx.userId, ctx.limiterIdentity ?? transportRateIdentity(ctx));
    },

    approveMergeUsersConsent: async (_: unknown, { proof, source, target }: { proof: string; source: string; target: string }, ctx: Context) =>
      approveUserMergeConsent(ctx, proof, source, target),

    mergeUsers: async (
      _: unknown,
      { input }: { input: { source: string; target: string; consentProof?: string } },
      ctx: Context,
    ) => {
      // #1642: platform administration plus both accounts' fresh-login consent.
      // Gate before resolving either account so denied callers learn no refs.
      requireRole(ctx, 'ADMIN');
      if (!input.consentProof) throw new GraphQLError('Both accounts must consent before merging.', { extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
      if (!ctx.userId || ctx.apiKeyId || ctx.sessionId || ctx.impersonation || ctx.appId) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
      const [{ id: sourceUserId }, { id: targetUserId }] = await Promise.all([
        resolveUserRef(ctx.db, input.source),
        resolveUserRef(ctx.db, input.target),
      ]);
      if (sourceUserId === targetUserId) {
        throw new GraphQLError('mergeUsers: source and target are the same user.', {
          extensions: { code: 'MERGE_SOURCE_EQUALS_TARGET', userId: sourceUserId },
        });
      }
      return mergeUsers(ctx.db, {
        sourceUserId,
        targetUserId,
        actorUserId: ctx.userId ?? null,
        mergeGlobalRoles: true,
        consentProof: input.consentProof,
      });
    },

    /**
     * deleteUser — self-serve account deletion (#662; Apple 5.1.1(v)).
     * CRUD-named principal-OR-self delete (conventions:crud-mutation-naming):
     * omitted userRef means "me"; a platform ADMIN/OWNER may name another
     * user. The heavy lifting (org auto-resolve, owned-data erasure, scrub)
     * lives in controller/operations/deleteUser.ts.
     */
    deleteUser: async (
      _: unknown,
      { userRef, reason }: { userRef?: string | null; reason?: string | null },
      ctx: Context,
    ) => {
      // A user credential is REQUIRED — an App key has no "me" and no
      // platform role axis, so it cannot delete accounts.
      if (!ctx.userId) {
        throw new GraphQLError('deleteUser requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      // #3016 (cor:aut:020:03): only an OMITTED (or null) userRef means "me".
      // A supplied ref that is empty after JS trim ('', spaces, a stray U+FEFF
      // BOM, an empty template variable) names nobody, so it is refused here,
      // before the principal check and before any target resolution. The
      // refusal does not depend on role or on any user row, so it reveals
      // nothing, and it can never fall through to erasing the caller.
      if (userRef != null && !userRef.trim()) {
        throw new GraphQLError('userRef is blank; omit it to delete your own account.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const forbidden = () =>
        new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
      // NON-throwing boolean principal check FIRST: the owner-or-self shape
      // must resolve the target before it can authorize, so every resolution
      // failure has to collapse into the same FORBIDDEN for non-principals —
      // otherwise NOT_FOUND-vs-FORBIDDEN becomes a user-enumeration oracle
      // (conventions:crud-mutation-naming, the deleteMemoryShare trap).
      const platformAdmin = isPlatformAdmin(ctx);
      let targetUserId: string;
      if (userRef == null) {
        // Omitted target = "me" (the self-service path; needs no role — a
        // platform admin's own admin bit never blocks their own deletion).
        targetUserId = ctx.userId;
      } else {
        try {
          ({ id: targetUserId } = await resolveUserRef(ctx.db, userRef));
        } catch (error) {
          // Non-principals get ONE indistinguishable error whether the named
          // user exists, doesn't exist, or the ref is malformed. Principals
          // get the real resolution error.
          if (!platformAdmin) throw forbidden();
          throw error;
        }
      }
      if (!platformAdmin && targetUserId !== ctx.userId) throw forbidden();
      // #1647 (cor:aut:020:03): erasing ANOTHER user's account takes a reason — trimmed, 1-500 Unicode code points.
      // Judged only AFTER the uniform FORBIDDEN above, so a non-admin never learns anything about reason or target.
      let auditReason: string | undefined;
      if (targetUserId !== ctx.userId) {
        const trimmed = (reason ?? '').trim();
        const length = [...trimmed].length;
        if (length < 1 || length > 500) {
          throw new GraphQLError('A reason of 1-500 characters is required to delete another user.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        auditReason = trimmed;
      }
      try {
        await deleteUserAccount(ctx.db, { targetUserId, actorUserId: ctx.userId, reason: auditReason });
      } catch (error) {
        if (error instanceof SoleOrgOwnerError) {
          throw new GraphQLError(error.message, {
            extensions: {
              code: 'SOLE_ORG_OWNER',
              organizations: error.organizations.map((o) => ({ id: o.id, name: o.name })),
            },
          });
        }
        throw error;
      }
      return true;
    },

    // ── Organization management ─────────────────────────────────────────

    createOrganization: async (
      _: unknown,
      { name, urn }: { name: string; urn: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      // #376: store only a bare org slug — a scheme-prefixed / colon-bearing
      // value would later cascade a corrupt `<orgUrn>:` prefix into children.
      // #1733: a bare, legal org root, dotted or not (validateOrgRoot).
      validateOrgRoot(urn);
      // #692: mint the org's principal (cross-kind pool uniqueness) and create
      // the org + owner in ONE transaction, so a name can never be half-claimed.
      const org = await ctx.db
        .$transaction(async (tx) => {
          const principal = await mintPrincipal(tx, { kind: 'org', name: urn });
          const created = await tx.organization.create({
            data: {
              name,
              urn,
              principalId: principal.id,
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            },
          });
          if (ctx.userId) {
            await tx.orgMember.create({
              data: { organizationId: created.id, userId: ctx.userId, role: 'OWNER', canInvite: true, createdBy: ctx.userId },
            });
          }
          return created;
        })
        .catch(rethrowRootNameTaken);
      return ctx.db.organization.findUniqueOrThrow({ where: { id: org.id }, include: ORG_INCLUDE });
    },

    updateOrganization: async (
      _: unknown,
      {
        id,
        name,
        urn,
        listedOnMarketplace,
        policy,
      }: { id: string; name?: string; urn?: string; listedOnMarketplace?: boolean; policy?: unknown },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      await requireOrgRole(ctx, resolvedId, 'ADMIN');

      // #510: the org-layer action-policy link (cor:acl:040:02). Explicit
      // null clears the link (= no restriction); omitted preserves.
      if (policy !== undefined && policy !== null && parsePolicyLink(policy) == null) {
        throw new GraphQLError('policy must be { allow: string[] } or null.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // #376: reject a malformed org URN BEFORE storing or cascading it.
      // `propagateOrgUrnRename` treats `<orgUrn>:` as an unambiguous prefix
      // boundary on every child URN; a scheme-prefixed / colon-bearing value
      // (e.g. the canonical `hrn:org:<slug>` the read resolver emits) would
      // corrupt every child in the one bulk rewrite. Fail loud here instead.
      // Validate whenever a urn is PROVIDED (incl. an empty string — which a
      // `String` GraphQL arg permits) so malformed input is rejected loudly
      // rather than silently dropped by the `if (!urn)` no-change fast-path;
      // only an omitted / explicit-null urn skips validation.
      if (urn != null) validateOrgRoot(urn);

      const data = {
        ...(name ? { name } : {}),
        ...(urn ? { urn } : {}),
        // NOT NULL column: treat an explicit null like an omitted arg (no
        // change) rather than letting Prisma attempt a NULL write (Copilot #688).
        ...(listedOnMarketplace != null ? { listedOnMarketplace } : {}),
        ...(policy !== undefined ? { policy: policy as never } : {}),
      };

      // Fast path: no URN change requested → a plain update.
      if (!urn) {
        return ctx.db.organization
          .update({
            where: { id: resolvedId },
            data,
            include: ORG_INCLUDE,
          });
      }

      // The org URN is denormalized into the `urn` column of every Memory,
      // Agent and App it owns (baked in at creation as `<orgUrn>::…`). Renaming
      // the org URN must rewrite those child copies too, or they dangle (issue
      // #337) — `propagateOrgUrnRename`. Lock the org row and read its current
      // urn INSIDE the transaction (FOR UPDATE) so a concurrent rename can't make
      // the rewrite source stale, then rewrite the children in the same tx so
      // they commit (or roll back) together.
      return ctx.db
        .$transaction(async (tx: Prisma.TransactionClient) => {
          const [locked] = await tx.$queryRaw<{ urn: string; principal_id: string | null }[]>`
            SELECT urn, principal_id FROM organizations WHERE id = ${resolvedId} FOR UPDATE
          `;
          const oldUrn = locked?.urn;
          const renaming = !!oldUrn && oldUrn !== urn;
          // #692: on a rename, mint the NEW root's principal first (fail-safe —
          // a taken name rolls back before we touch the old), then tombstone the
          // OLD name (kept reserved), then re-point the org.
          let updateData: Prisma.OrganizationUncheckedUpdateInput = data;
          if (renaming) {
            const principal = await mintPrincipal(tx, { kind: 'org', name: urn });
            if (locked?.principal_id) await releasePrincipal(tx, locked.principal_id);
            updateData = { ...data, principalId: principal.id };
          }
          const updated = await tx.organization.update({
            where: { id: resolvedId },
            data: updateData,
            include: ORG_INCLUDE,
          });
          if (renaming) {
            // #1079 — record the org's OWN alias before cascading. Organization
            // is the one renameable entity with no `legacy_urn` column (it was
            // outside the #697 migration), so until the alias map it had no
            // aliasing at all: an org rename made every published URN in the
            // tenancy unresolvable, its own included.
            await recordUrnRename(tx, {
              entityType: 'ORGANIZATION',
              entityId: resolvedId,
              oldUrn: oldUrn as string,
              newUrn: urn,
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            });
            await propagateOrgUrnRename(tx, resolvedId, oldUrn as string, urn, {
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            });
          }
          return updated;
        })
        .catch(rethrowRootNameTaken);
    },

    deleteOrganization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      // Atomically soft-delete the org and hard-delete its org-scoped secrets
      // (#677) — the ONE org soft-delete cascade, shared with deleteUser's
      // sole-member-org branch (see softDeleteOrganizationCore for the
      // idempotency + secret-sweep rationale).
      await withAuthorizedTx(
        ctx,
        [{ kind: 'org', id: resolvedId }],
        async (txCtx) => { requireRole(txCtx, 'ADMIN'); },
        (tx) => softDeleteOrganizationCore(tx, resolvedId),
        { lockMode: 'exclusive', allowDeletedOrg: true },
      );
      return true;
    },

    linkGithubApp: async (
      _: unknown,
      { orgId, installationId }: { orgId: string; installationId: number },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: resolvedOrgId },
        data: { githubInstallationId: installationId },
        include: ORG_INCLUDE,
      });
    },

    updateOrgGithubApp: async (
      _: unknown,
      { orgId, appId, privateKey }: { orgId: string; appId: string; privateKey: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const encrypted = encryptToken(privateKey);
      return ctx.db.organization.update({
        where: { id: resolvedOrgId },
        data: { githubAppId: appId, githubAppPrivateKeyEncrypted: encrypted },
        include: ORG_INCLUDE,
      });
    },

    unlinkGithubApp: async (
      _: unknown,
      { orgId }: { orgId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: resolvedOrgId },
        data: {
          githubInstallationId: null,
          githubAppId: null,
          githubAppPrivateKeyEncrypted: null,
        },
        include: ORG_INCLUDE,
      });
    },

    // ── User invitations ────────────────────────────────────────────────

    createUserInvitation: async (
      _: unknown,
      {
        orgId,
        memberRole,
        name,
        email,
        githubUsername,
        maxActivations,
        expiresInDays,
      }: {
        orgId: string; memberRole: string;
        name?: string; email?: string; githubUsername?: string;
        maxActivations?: number; expiresInDays?: number;
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      const slug = generateId().slice(0, 16);
      const invite = await withAuthorizedTx(
        ctx,
        [{ kind: 'org', id: resolvedOrgId }],
        (txCtx) => requireOrgRole(txCtx, resolvedOrgId, 'ADMIN'),
        (tx) => {
          // #2984: judged after the role gate, so a refused caller gets the same answer whatever the values.
          assertInviteLimits({ expiresInDays, maxActivations });
          return tx.userInvitation.create({
            data: {
              id: generateId(),
              slug,
              senderUserId: ctx.userId ?? null,
              organizationId: resolvedOrgId,
              memberRole: (memberRole as Role) ?? 'READER',
              name: name ?? null,
              email: email ?? null,
              githubUsername: githubUsername ?? null,
              maxActivations: inviteMaxActivations(maxActivations),
              expiresAt: inviteExpiresAt(expiresInDays),
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            },
            include: { sender: true, organization: true, activations: true },
          });
        },
      );
      return { ...invite, activationCount: invite.activations.length };
    },

    inviteUser: async (
      _: unknown,
      { name, email, githubUsername, maxActivations, expiresInDays }: {
        name?: string; email?: string; githubUsername?: string;
        maxActivations?: number; expiresInDays?: number;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      assertInviteLimits({ expiresInDays, maxActivations }); // #2984
      const slug = generateId().slice(0, 16);
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId,
          organizationId: null,
          memberRole: 'READER',
          name: name ?? null,
          email: email ?? null,
          githubUsername: githubUsername ?? null,
          maxActivations: inviteMaxActivations(maxActivations),
          expiresAt: inviteExpiresAt(expiresInDays),
          createdBy: ctx.userId,
        },
        include: { sender: true, organization: true, activations: true },
      });
      return { ...invite, activationCount: invite.activations.length };
    },

    acceptInvitation: async (
      _: unknown,
      { slug }: { slug: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('You must be signed in to accept an invitation', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }

      // Resolve only the anchor shape outside the transaction. The invitation
      // and activation decisions are re-read after its row lock below.
      const candidate = await ctx.db.userInvitation.findUnique({
        where: { slug }, select: { id: true, organizationId: true, senderUserId: true },
      });
      if (!candidate) throw invitationNotFound();
      return withAuthorizedTx(
        ctx,
        [
          ...(candidate.organizationId ? [{ kind: 'org' as const, id: candidate.organizationId }] : []),
          ...(candidate.senderUserId ? [{ kind: 'user' as const, id: candidate.senderUserId }] : []),
        ],
        async () => {},
        async (tx, txCtx) => {
          const invite = await tx.userInvitation.findUnique({
            where: { id: candidate.id }, include: { activations: true },
          });
          if (!invite || invite.deletedAt || invite.organizationId !== candidate.organizationId ||
              invite.senderUserId !== candidate.senderUserId) {
            throw invitationNotFound();
          }
          if (invite.expiresAt && invite.expiresAt < new Date()) throw new GraphQLError('Invitation has expired', { extensions: { code: 'BAD_USER_INPUT' } });
          if (invite.maxActivations && invite.activations.length >= invite.maxActivations) {
            throw new GraphQLError('Invitation has reached its maximum number of uses', {
              extensions: { code: 'CONFLICT' },
            });
          }
          if (invite.activations.some((a) => a.userId === ctx.userId)) {
            throw new GraphQLError('You have already accepted this invitation', {
              extensions: { code: 'CONFLICT' },
            });
          }
          if (invite.organizationId && invite.senderUserId) {
            const issuer = await tx.user.findFirst({
              where: { id: invite.senderUserId, deletedAt: null }, select: { roles: true },
            });
            if (!issuer) throw invitationRevoked();
            try {
              await requireOrgRole({
                ...txCtx, userId: invite.senderUserId, roles: issuer.roles,
                apiKeyId: undefined, appId: undefined, clientId: undefined,
                impersonation: undefined,
              }, invite.organizationId, 'ADMIN');
            } catch (error) {
              if (error instanceof GraphQLError && error.extensions.code === 'FORBIDDEN') {
                throw invitationRevoked();
              }
              throw error;
            }
          }

          await tx.userInvitationActivation.create({
            data: {
              id: generateId(), invitationId: invite.id, userId: ctx.userId!, createdBy: ctx.userId,
            },
          });
          // A tombstoned composite membership is reactivated, with every
          // revoked capability cleared. A live membership remains a no-op.
          if (invite.organizationId) {
            const existing = await tx.orgMember.findUnique({
              where: { organizationId_userId: { organizationId: invite.organizationId, userId: ctx.userId! } },
            });
            if (!existing) {
              await tx.orgMember.create({
                data: {
                  id: generateId(), organizationId: invite.organizationId, userId: ctx.userId!,
                  role: invite.memberRole as Role, createdBy: ctx.userId,
                },
              });
            } else if (existing.deletedAt) {
              await tx.orgMember.update({
                where: { organizationId_userId: { organizationId: invite.organizationId, userId: ctx.userId! } },
                data: {
                  deletedAt: null, deletedBy: null, role: invite.memberRole as Role,
                  canInvite: false, updatedBy: ctx.userId,
                },
              });
            }
          }
          return true;
        },
        {
          afterLock: async (tx) => {
            await tx.$queryRaw`SELECT id FROM user_invitations WHERE id = ${candidate.id} FOR UPDATE`;
            if (candidate.organizationId) {
              await tx.$queryRaw`
                SELECT id FROM org_members
                WHERE organization_id = ${candidate.organizationId} AND user_id = ${ctx.userId} FOR UPDATE`;
            }
          },
        },
      );
    },

    // ── Organization membership ─────────────────────────────────────────

    addOrgMember: async (
      _: unknown,
      {
        orgRef,
        orgId,
        userRef,
        userId,
        role,
      }: {
        orgRef?: string | null;
        orgId?: string | null;
        userRef?: string | null;
        userId?: string | null;
        role: string;
      },
      ctx: Context,
    ) => {
      // #764 (was 007-entity-id-or-urn): orgRef/userRef accept id / URN / (org)
      // handle / (user) email. Resolve the org + admin-gate FIRST, then resolve
      // the user (auth before revealing user existence).
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      return withAuthorizedTx(
        ctx,
        [{ kind: 'org', id: resolvedOrgId }, { kind: 'user', id: resolvedUserId }],
        (txCtx) => requireOrgRole(txCtx, resolvedOrgId, 'ADMIN'),
        async (tx) => {
          // Membership revocation is a soft delete, so the composite (org,
          // user) PK may hold a tombstone. Reactivate it rather than insert a
          // duplicate, but never let the pre-transaction read decide this.
          const existing = await tx.orgMember.findUnique({
            where: { organizationId_userId: { organizationId: resolvedOrgId, userId: resolvedUserId } },
          });
          if (existing && !existing.deletedAt) {
            throw orgMemberRefusal('CONFLICT', 'User is already a member of this organization');
          }
          if (existing) {
            return tx.orgMember.update({
              where: { organizationId_userId: { organizationId: resolvedOrgId, userId: resolvedUserId } },
              data: {
                deletedAt: null,
                deletedBy: null,
                role: role as Role,
                // Revocation clears ALL membership capabilities.
                canInvite: false,
                updatedBy: ctx.userId ?? ctx.clientId ?? null,
              },
              include: { user: true },
            });
          }
          return tx.orgMember.create({
            data: { id: generateId(), organizationId: resolvedOrgId, userId: resolvedUserId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
            include: { user: true },
          });
        },
        { afterLock: async (tx) => {
          await tx.$queryRaw`SELECT id FROM org_members WHERE organization_id = ${resolvedOrgId} AND user_id = ${resolvedUserId} FOR UPDATE`;
        } },
      );
    },

    updateOrgMember: async (
      _: unknown,
      {
        orgRef,
        orgId,
        userRef,
        userId,
        role,
      }: {
        orgRef?: string | null;
        orgId?: string | null;
        userRef?: string | null;
        userId?: string | null;
        role: string;
      },
      ctx: Context,
    ) => {
      // #764: orgRef/userRef accept id / URN / (org) handle / (user) email.
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      // #1544: the last-owner guard is count-then-act, so the read, the count
      // and the write share ONE SERIALIZABLE transaction. Two admins demoting
      // (or removing) the org's two owners at once would otherwise each count
      // two and both commit, leaving zero owners. Every writer that can lower
      // the owner count is SERIALIZABLE (removeOrgMember, deleteUser), so
      // Postgres aborts one side and the retry re-decides on the winner's
      // committed state (conventions:count-then-act-serializable-txn).
      let existingRole: Role | null = null;
      return retryOnSerializationFailure(() => withAuthorizedTx(
        ctx,
        [{ kind: 'org', id: resolvedOrgId }, { kind: 'user', id: resolvedUserId }],
        (txCtx) => requireOrgRole(txCtx, resolvedOrgId, 'ADMIN'),
        async (tx) => {
        // The typed miss comes only after the in-transaction authorize that
        // runs before this write: a caller revoked before or while queued must
        // get FORBIDDEN (or 40001), never learn the target is absent (#2871).
        if (!existingRole) throw orgMemberRefusal('NOT_FOUND', 'User is not a member of this organization');
        // Demoting the last LIVE owner would leave the org unmanageable — same
        // invariant removeOrgMember enforces (PR-480 Gemini review; the gap
        // predates the lifecycle change but this is its home).
        if (existingRole === 'OWNER' && role !== 'OWNER') {
          const owners = await tx.orgMember.count({
            where: { organizationId: resolvedOrgId, role: 'OWNER', deletedAt: null },
          });
          if (owners <= 1) {
            throw orgMemberRefusal('CONFLICT', 'Cannot demote the last owner of an organization');
          }
        }
        if ((existingRole === 'OWNER' || existingRole === 'ADMIN') &&
            role !== 'OWNER' && role !== 'ADMIN') {
          await assertIssuerInvitationSnapshotFresh(tx, ctx.db, resolvedOrgId, resolvedUserId);
          await revokeOrgInvitationsByIssuer(
            tx, resolvedOrgId, resolvedUserId, ctx.userId ?? ctx.clientId ?? null,
          );
        }
        return tx.orgMember.update({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: resolvedUserId } },
          data: { role: role as Role },
          include: { user: true },
        });
        },
        {
          afterLock: async (tx) => {
            // The authority anchor is held before these row locks. Under
            // SERIALIZABLE the actor's locking read forces 40001 if a revoke
            // committed while this transaction waited on the anchor.
            const rows = await tx.$queryRaw<Array<{ role: Role }>>`
              SELECT role FROM org_members
              WHERE organization_id = ${resolvedOrgId} AND user_id = ${resolvedUserId}
                AND deleted_at IS NULL FOR UPDATE`;
            const fresh = await ctx.db.$queryRaw<Array<{ role: Role }>>`
              SELECT role FROM org_members
              WHERE organization_id = ${resolvedOrgId} AND user_id = ${resolvedUserId}
                AND deleted_at IS NULL`;
            if (Boolean(rows[0]) !== Boolean(fresh[0])) throw new AuthoritySnapshotStale();
            existingRole = rows[0]?.role ?? null;
            if (ctx.userId) {
              await tx.$queryRaw`
                SELECT id FROM org_members
                WHERE organization_id = ${resolvedOrgId} AND user_id = ${ctx.userId}
                  AND deleted_at IS NULL FOR SHARE`;
            }
          },
          lockMode: 'exclusive',
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      ));
    },

    removeOrgMember: async (
      _: unknown,
      {
        orgRef,
        orgId,
        userRef,
        userId,
      }: {
        orgRef?: string | null;
        orgId?: string | null;
        userRef?: string | null;
        userId?: string | null;
      },
      ctx: Context,
    ) => {
      // #764: orgRef/userRef accept id / URN / (org) handle / (user) email.
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      // #1544: one SERIALIZABLE transaction for the read, the last-owner count
      // and the revocation, for the reason updateOrgMember gives above.
      await retryOnSerializationFailure(() => withAuthorizedTx(
        ctx,
        [{ kind: 'org', id: resolvedOrgId }, { kind: 'user', id: resolvedUserId }],
        (txCtx) => requireOrgRole(txCtx, resolvedOrgId, 'ADMIN'),
        async (tx) => {
        const member = await tx.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: resolvedUserId } },
        });
        // A user who never held a row is not a member (#2871); a revoked row is
        // the idempotent case below.
        if (!member) throw orgMemberRefusal('NOT_FOUND', 'User is not a member of this organization');
        // Already revoked → idempotent success. Checked BEFORE the last-owner
        // guard: a revoked ex-OWNER isn't in the live owners count, so the
        // guard would otherwise mis-fire "last owner" on a no-op re-removal.
        if (member.deletedAt) return;
        // Cannot remove the last LIVE owner (revoked owners don't count — and
        // this implicitly protects personal workspaces, whose user is the sole
        // OWNER of their personal org).
        if (member.role === 'OWNER') {
          const owners = await tx.orgMember.count({
            where: { organizationId: resolvedOrgId, role: 'OWNER', deletedAt: null },
          });
          if (owners <= 1) {
            throw orgMemberRefusal('CONFLICT', 'Cannot remove the last owner of an organization');
          }
        }
        await assertIssuerInvitationSnapshotFresh(tx, ctx.db, resolvedOrgId, resolvedUserId);
        // Revocation is a SOFT delete (OrgMember carries the audit tuple; the
        // platform hard-deletes only pure join rows — cor:dmo:010:04). Every
        // read/auth gate filters deletedAt, and rejoin reactivates the row via
        // addOrgMember / invitation acceptance, so history is preserved without
        // ever authorizing a revoked member.
        await tx.orgMember.update({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: resolvedUserId } },
          data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
        });
        await revokeOrgInvitationsByIssuer(
          tx, resolvedOrgId, resolvedUserId, ctx.userId ?? ctx.clientId ?? null,
        );
        },
        {
          lockMode: 'exclusive',
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          afterLock: async (tx) => {
            const rows = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM org_members
              WHERE organization_id = ${resolvedOrgId} AND user_id = ${resolvedUserId} FOR UPDATE`;
            const fresh = await ctx.db.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM org_members
              WHERE organization_id = ${resolvedOrgId} AND user_id = ${resolvedUserId}`;
            if (Boolean(rows[0]) !== Boolean(fresh[0])) throw new AuthoritySnapshotStale();
            if (ctx.userId) {
              await tx.$queryRaw`
                SELECT id FROM org_members
                WHERE organization_id = ${resolvedOrgId} AND user_id = ${ctx.userId}
                  AND deleted_at IS NULL FOR SHARE`;
            }
          },
        },
      ));
      return true;
    },

    // ── Memory management ────────────────────────────────────────────────

    joinWaitingList: async (
      _: unknown,
      { email, requestedFeatures }: { email: string; requestedFeatures?: string },
      ctx: Context,
    ) => {
      await ctx.db.waitingListItem.create({
        data: { email: email.trim().toLowerCase(), requestedFeatures: requestedFeatures ?? null },
      });
      return true;
    },

    sendContactMessage: async (
      _: unknown,
      { name, email, message }: { name: string; email: string; message: string },
    ) => {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error('Email service not configured');
      const contactEmail = process.env.CONTACT_EMAIL ?? 'info@baragaun.com';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: 'Hadron <noreply@hadronmemory.com>',
          to: contactEmail,
          subject: `Contact from ${name}`,
          text: `New contact form submission:\n\nFrom: ${name} <${email}>\n\n${message}`,
        }),
      });
      return true;
    },

    // ── Chat API ────────────────────────────────────────────────────────

    createAppUser: async (
      _: unknown,
      { externalId, handle, name, email }: { externalId: string; handle?: string; name?: string; email?: string },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw forbiddenError('Forbidden: App Key required');
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      if (app.createUserPermission === 'DENY') {
        throw forbiddenError('Forbidden: this app cannot create users');
      }
      // App-provided profile data cannot establish a verified identity.
      if (email?.trim()) {
        throw new GraphQLError('Email cannot be established through App user provisioning.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // Idempotent: return existing user if already created under this app
      const existing = await ctx.db.user.findFirst({
        where: { externalAppId: ctx.appId, externalId, deletedAt: null },
      });
      if (existing) return existing;

      // Handle is NOT NULL (spec 047). Honor an explicit, legal app-supplied
      // handle; otherwise assign a RANDOM one. App end-users are addressed by
      // (externalAppId, externalId), not by handle, and aren't the `@handle`
      // owner persona — so we deliberately do NOT seed from name/email/externalId
      // (that would leak app-internal PII into a global handle). The seed is
      // gated through normalizeHandleOrNull so an illegal value (a name, an
      // email) normalizes to null → bare random, never sanitized into a handle.
      const handle_ = await generateUniqueHandle(ctx.db, {
        seeds: [normalizeHandleOrNull(handle)],
      });
      // #692: create the app-user + mint its pool principal in one transaction.
      return ctx.db
        .$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              externalAppId: ctx.appId,
              externalId,
              identityProvider: 'APP',
              handle: handle_,
              name: name ?? null,
              createdBy: ctx.appId,
            },
          });
          await ensureUserPrincipal(tx, user);
          return user;
        })
        .catch(rethrowRootNameTaken);
    },

};
