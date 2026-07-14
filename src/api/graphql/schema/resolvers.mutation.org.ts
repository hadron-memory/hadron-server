// orgMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { GraphQLError } from 'graphql';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { parsePolicyLink } from '@hadron-memory/access-control';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import {
  normalizeHandle,
  generateUniqueHandle,
} from '../../../lib/userHandle.js';
import { propagateOrgUrnRename } from '../../../lib/org/propagateOrgUrnRename.js';
import { validateOrgSlug } from '../../../lib/urn.js';
import {
  Prisma,
  type Role,
} from '../../../generated/prisma/index.js';
import {
  type Context,
  requireRole,
  requireOrgRole,
  ORG_INCLUDE,
} from './resolvers.helpers.js';

export const orgMutations = {
    updateMyProfile: async (
      _: unknown,
      { name, handle, email }: { name?: string; handle?: string | null; email?: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // A handle is the hrn:user:<handle> slug — normalize to lowercase-canonical
      // and validate (#325). `undefined` leaves it unchanged; `null`/empty clears
      // it (clients pass explicit null to clear); an illegal handle throws.
      const handleData =
        handle === undefined
          ? {}
          : { handle: !handle || handle.trim() === '' ? null : normalizeHandle(handle) };
      return ctx.db.user.update({
        where: { id: ctx.userId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...handleData,
          ...(email !== undefined ? { email } : {}),
        },
      });
    },

    updateUserRoles: async (
      _: unknown,
      { userId, roles }: { userId: string; roles: Role[] },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.update({ where: { id: userId }, data: { roles } });
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
      validateOrgSlug(urn);
      const org = await ctx.db.organization.create({
        data: { name, urn, isVisible: true, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: ORG_INCLUDE,
      });
      if (ctx.userId) {
        await ctx.db.orgMember.create({
          data: { organizationId: org.id, userId: ctx.userId, role: 'OWNER', canInvite: true, createdBy: ctx.userId },
        });
      }
      return ctx.db.organization.findUniqueOrThrow({ where: { id: org.id }, include: ORG_INCLUDE });
    },

    updateOrganization: async (
      _: unknown,
      {
        id,
        name,
        urn,
        isVisible,
        policy,
      }: { id: string; name?: string; urn?: string; isVisible?: boolean; policy?: unknown },
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
      if (urn != null) validateOrgSlug(urn);

      const data = {
        ...(name ? { name } : {}),
        ...(urn ? { urn } : {}),
        ...(isVisible !== undefined ? { isVisible } : {}),
        ...(policy !== undefined ? { policy: policy as never } : {}),
      };

      // Fast path: no URN change requested → a plain update.
      if (!urn) {
        return ctx.db.organization.update({
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
      return ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        const [locked] = await tx.$queryRaw<{ urn: string }[]>`
          SELECT urn FROM organizations WHERE id = ${resolvedId} FOR UPDATE
        `;
        const oldUrn = locked?.urn;
        const updated = await tx.organization.update({
          where: { id: resolvedId },
          data,
          include: ORG_INCLUDE,
        });
        if (oldUrn && oldUrn !== urn) {
          await propagateOrgUrnRename(tx, resolvedId, oldUrn, urn);
        }
        return updated;
      });
    },

    deleteOrganization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      await ctx.db.organization.update({ where: { id: resolvedId }, data: { deletedAt: new Date() } });
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
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId ?? null,
          organizationId: resolvedOrgId,
          memberRole: (memberRole as Role) ?? 'READER',
          name: name ?? null,
          email: email ?? null,
          githubUsername: githubUsername ?? null,
          maxActivations: maxActivations ?? 1,
          expiresAt,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { sender: true, organization: true, activations: true },
      });
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
      if (!ctx.userId) throw new Error('Unauthenticated');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
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
          maxActivations: maxActivations ?? 1,
          expiresAt,
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
      if (!ctx.userId) throw new Error('You must be signed in to accept an invitation');

      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        include: { activations: true },
      });
      if (!invite || invite.deletedAt) throw new Error('Invitation not found');
      if (invite.expiresAt && invite.expiresAt < new Date()) throw new Error('Invitation has expired');
      if (invite.maxActivations && invite.activations.length >= invite.maxActivations) {
        throw new Error('Invitation has reached its maximum number of uses');
      }

      // Check if user already activated this invite
      if (invite.activations.some((a: any) => a.userId === ctx.userId)) {
        throw new Error('You have already accepted this invitation');
      }

      // Create activation record
      await ctx.db.userInvitationActivation.create({
        data: {
          id: generateId(),
          invitationId: invite.id,
          userId: ctx.userId!,
          createdBy: ctx.userId ?? null,
        },
      });

      // Add user to org if not already a LIVE member. A soft-revoked row
      // (membership revocation is a soft delete — the audit tuple persists)
      // is REACTIVATED with the invite's role: accepting a fresh invitation
      // is the sanctioned rejoin path for a removed ex-member, and the
      // composite (org, user) PK means a second row can't be created anyway.
      if (invite.organizationId) {
        const existing = await ctx.db.orgMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: invite.organizationId,
              userId: ctx.userId!,
            },
          },
        });
        if (!existing) {
          await ctx.db.orgMember.create({
            data: {
              id: generateId(),
              organizationId: invite.organizationId,
              userId: ctx.userId!,
              role: invite.memberRole as Role,
              createdBy: ctx.userId ?? null,
            },
          });
        } else if (existing.deletedAt) {
          await ctx.db.orgMember.update({
            where: {
              organizationId_userId: {
                organizationId: invite.organizationId,
                userId: ctx.userId!,
              },
            },
            data: {
              deletedAt: null,
              deletedBy: null,
              role: invite.memberRole as Role,
              // Revocation clears ALL membership capabilities — a fresh row
              // would default canInvite=false, so reactivation must not
              // resurrect a stale invite grant (PR-480 review).
              canInvite: false,
              updatedBy: ctx.userId ?? null,
            },
          });
        }
        // A live membership is a no-op (the activation is still recorded).
      }

      return true;
    },

    // ── Organization membership ─────────────────────────────────────────

    addOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      // (userId is keyed by raw ID — User has no urn column.)
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      // Membership revocation is a soft delete, so the composite (org, user)
      // PK may hold a tombstone. Reactivate it with the new role instead of
      // letting the create fail with a raw P2002; a LIVE duplicate gets a
      // clean typed error instead of P2002 too.
      const existing = await ctx.db.orgMember.findUnique({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
      });
      if (existing && !existing.deletedAt) {
        throw new Error('User is already a member of this organization');
      }
      if (existing) {
        return ctx.db.orgMember.update({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
          data: {
            deletedAt: null,
            deletedBy: null,
            role: role as Role,
            // Revocation clears ALL membership capabilities — reactivation
            // must not resurrect a stale canInvite grant (PR-480 review).
            canInvite: false,
            updatedBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: { user: true },
        });
      }
      return ctx.db.orgMember.create({
        data: { id: generateId(), organizationId: resolvedOrgId, userId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { user: true },
      });
    },

    updateOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      // Refuse to edit a soft-revoked row — silently retitling a tombstone
      // (which no UI surfaces) would be API-misuse-only behavior; rejoin goes
      // through addOrgMember / invitation reactivation.
      const existing = await ctx.db.orgMember.findFirst({
        where: { organizationId: resolvedOrgId, userId, deletedAt: null },
      });
      if (!existing) {
        throw new Error('User is not a member of this organization');
      }
      // Demoting the last LIVE owner would leave the org unmanageable — same
      // invariant removeOrgMember enforces (PR-480 Gemini review; the gap
      // predates the lifecycle change but this is its home).
      if (existing.role === 'OWNER' && role !== 'OWNER') {
        const owners = await ctx.db.orgMember.findMany({
          where: { organizationId: resolvedOrgId, role: 'OWNER', deletedAt: null },
        });
        if (owners.length <= 1) {
          throw new Error('Cannot demote the last owner of an organization');
        }
      }
      return ctx.db.orgMember.update({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
        data: { role: role as Role },
        include: { user: true },
      });
    },

    removeOrgMember: async (
      _: unknown,
      { orgId, userId }: { orgId: string; userId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const member = await ctx.db.orgMember.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
      });
      // Already revoked → idempotent success. Checked BEFORE the last-owner
      // guard: a revoked ex-OWNER isn't in the live owners count, so the
      // guard would otherwise mis-fire "last owner" on a no-op re-removal.
      if (member.deletedAt) return true;
      // Cannot remove the last LIVE owner (revoked owners don't count — and
      // this implicitly protects personal workspaces, whose user is the sole
      // OWNER of their personal org).
      if (member.role === 'OWNER') {
        const owners = await ctx.db.orgMember.findMany({
          where: { organizationId: resolvedOrgId, role: 'OWNER', deletedAt: null },
        });
        if (owners.length <= 1) {
          throw new Error('Cannot remove the last owner of an organization');
        }
      }
      // Revocation is a SOFT delete (OrgMember carries the audit tuple; the
      // platform hard-deletes only pure join rows — cor:dmo:010:04). Every
      // read/auth gate filters deletedAt, and rejoin reactivates the row via
      // addOrgMember / invitation acceptance, so history is preserved without
      // ever authorizing a revoked member.
      await ctx.db.orgMember.update({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
      });
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
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      if (app.createUserPermission === 'DENY') {
        throw new Error('Forbidden: this app cannot create users');
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
      // (that would leak app-internal PII into a global handle).
      const handle_ = await generateUniqueHandle(ctx.db, { seeds: [handle] });
      return ctx.db.user.create({
        data: {
          externalAppId: ctx.appId,
          externalId,
          identityProvider: 'APP',
          handle: handle_,
          name: name ?? null,
          email: email ?? null,
          createdBy: ctx.appId,
        },
      });
    },

};

