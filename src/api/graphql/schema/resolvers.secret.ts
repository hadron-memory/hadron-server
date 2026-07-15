/**
 * General-secret-store GraphQL surface (#677) — the write path backing the
 * v1 CLI (`hadron secret create/ls/rm`) plus the inspectable read surface.
 * The value is WRITE-ONLY: `valueEncrypted` is a column no field here ever
 * selects or exposes (redaction by construction — same posture as the
 * aiConfig / HA / Resend / MCP registries); `kind` + `metadata` are the
 * inspectable half. The row grants nothing by itself — run-time use walks
 * the cascade resolver under the run principal (src/lib/runner/secrets.ts).
 *
 * Authorization matrix (issue #677):
 *   owner    | create/update/delete            | see-it-exists (read surface)
 *   user     | that user (strict, no admin)    | that user
 *   org      | org ADMIN                        | org member
 *   app      | app owner / org ADMIN            | app owner / org member
 *   memory   | memory WRITE                     | memory READ
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import {
  clampListTake,
  isOrgMemberOrAdmin,
  isOwnerOrOrgMember,
  requireMemoryWriteAccess,
  requireOrgRole,
  requireOwnerOrOrgRole,
} from './resolvers.helpers.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { resolveSecretRef } from '../../../lib/entityRef/secretRef.js';
import {
  decryptSecretValue,
  isSecretOwnerType,
  SECRET_NAME_RE,
  SECRET_OWNER_TYPES,
  validateAndEncryptSecret,
  type SecretOwnerType,
} from '../../../lib/secrets.js';

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** Project the resolver Context onto the AuthContext canReadMemory expects. */
function secretAuthContext(ctx: Context) {
  return {
    clientId: ctx.clientId,
    userId: ctx.userId,
    appId: ctx.appId,
    sessionId: ctx.sessionId,
    roles: ctx.roles,
    organizationId: ctx.organizationId,
    apiKeyId: ctx.apiKeyId,
  };
}

function assertOwnerType(value: unknown): SecretOwnerType {
  if (!isSecretOwnerType(value)) {
    throw badInput(`ownerType must be one of: ${SECRET_OWNER_TYPES.join(', ')}.`);
  }
  return value;
}

/**
 * Resolve a secret ref — a cuid id OR an `hrn:secret:…` URN (#683) — to its
 * full row, or null when it is malformed / names an absent owner or secret.
 * Keeps the no-existence-disclosure posture: a bad URN and a missing secret
 * are both `null` here, and the caller's entitlement gate then applies.
 */
async function findSecretByRef(ctx: Context, ref: string) {
  let id: string;
  try {
    ({ id } = await resolveSecretRef(ctx.db, ref));
  } catch {
    return null;
  }
  return ctx.db.secret.findUnique({ where: { id } });
}

/**
 * Resolve an owner reference (ID or URN per cor:api:140) to the owning
 * entity's ID. For `user`, an omitted ref defaults to the caller — the only
 * principal the matrix lets manage user-scoped secrets anyway.
 */
async function resolveSecretOwnerRef(
  ctx: Context,
  ownerType: SecretOwnerType,
  ownerRef: string | null | undefined,
): Promise<string> {
  switch (ownerType) {
    case 'user': {
      if (ownerRef == null) {
        if (!ctx.userId) throw new Error('Forbidden');
        return ctx.userId;
      }
      return (await resolveUserRef(ctx.db, ownerRef)).id;
    }
    case 'org': {
      if (ownerRef == null) throw badInput('ownerRef is required for org-scoped secrets.');
      return (await resolveOrgRef(ctx.db, ownerRef)).id;
    }
    case 'app': {
      if (ownerRef == null) throw badInput('ownerRef is required for app-scoped secrets.');
      return (await resolveAppRef(ctx.db, ownerRef)).id;
    }
    case 'memory': {
      if (ownerRef == null) throw badInput('ownerRef is required for memory-scoped secrets.');
      return (await resolveMemoryRef(ctx.db, ownerRef)).id;
    }
  }
}

/**
 * Write gate per the #677 matrix. `user` is STRICT owner-only — no
 * platform-admin bypass, mirroring the personal/private-memory posture
 * (a user's secrets are theirs, not the operator's).
 */
async function requireSecretOwnerWrite(
  ctx: Context,
  ownerType: SecretOwnerType,
  ownerId: string,
): Promise<void> {
  switch (ownerType) {
    case 'user': {
      if (ctx.userId && ctx.userId === ownerId) return;
      throw new Error('Forbidden');
    }
    case 'org': {
      await requireOrgRole(ctx, ownerId, 'ADMIN');
      return;
    }
    case 'app': {
      const app = await ctx.db.app.findUnique({ where: { id: ownerId } });
      if (!app) throw new Error('Forbidden');
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
      return;
    }
    case 'memory': {
      await requireMemoryWriteAccess(ctx, ownerId);
      return;
    }
  }
}

/**
 * Read-level gate: may the caller see that this owner's secrets EXIST
 * (kind + metadata, never the value)? Boolean and graceful — a `false`
 * renders as null/empty page, indistinguishable from missing.
 */
async function canSeeSecretOwner(
  ctx: Context,
  ownerType: SecretOwnerType,
  ownerId: string,
): Promise<boolean> {
  switch (ownerType) {
    case 'user':
      return !!ctx.userId && ctx.userId === ownerId;
    case 'org':
      return isOrgMemberOrAdmin(ctx, ownerId);
    case 'app': {
      const app = await ctx.db.app.findUnique({ where: { id: ownerId } });
      return app ? isOwnerOrOrgMember(ctx, app) : false;
    }
    case 'memory': {
      // Use the shared class-aware read gate (the SAME predicate the runtime
      // cascade uses), NOT the portal getAccessibleMemoryIds — the latter
      // grants an App-key caller no memory access outside an active session,
      // so it would drift from the write gate (requireMemoryWriteAccess folds
      // in canWriteToMemory): an App key could create a memory-scoped secret
      // it then couldn't see/update/delete (Codex P2). canReadMemory keeps
      // the `memory READ` matrix uniform across principal types.
      return canReadMemory(ctx.db, secretAuthContext(ctx), ownerId);
    }
  }
}

export interface CreateSecretArgs {
  ownerType: string;
  ownerRef?: string | null;
  name: string;
  kind: string;
  metadata?: Record<string, unknown> | null;
  value: unknown;
}

export interface UpdateSecretArgs {
  ref: string;
  metadata?: Record<string, unknown> | null;
  value?: unknown;
}

export const secretMutations = {
  /** Create a named, owner-scoped secret (gate per the #677 matrix). */
  createSecret: async (_: unknown, args: CreateSecretArgs, ctx: Context) => {
    const ownerType = assertOwnerType(args.ownerType);
    const ownerId = await resolveSecretOwnerRef(ctx, ownerType, args.ownerRef);
    await requireSecretOwnerWrite(ctx, ownerType, ownerId);

    const name = args.name.trim().toLowerCase();
    if (!SECRET_NAME_RE.test(name)) {
      throw badInput('name must be lowercase [a-z0-9-], start alphanumeric, max 64 chars.');
    }
    const { metadata, valueEncrypted } = validateAndEncryptSecret(args.kind, args.metadata, args.value);

    try {
      return await ctx.db.secret.create({
        data: {
          ownerType,
          ownerId,
          name,
          kind: args.kind,
          metadata: metadata as never,
          valueEncrypted,
          createdBy: ctx.userId ?? ctx.appId ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw badInput(`A secret named "${name}" already exists at this scope.`);
      }
      throw err;
    }
  },

  /**
   * Overwrite a secret's value and/or metadata (v1 rotation — no
   * versioning). Name, kind, and owner are immutable: flow config and the
   * cascade reference the name, so renaming would silently orphan them —
   * create a new name instead. The effective (metadata, value) pair is
   * re-validated per kind, decrypting the stored value server-side when
   * only metadata changes, so the two halves can never drift apart.
   */
  updateSecret: async (_: unknown, args: UpdateSecretArgs, ctx: Context) => {
    const secret = await findSecretByRef(ctx, args.ref);
    // Missing and not-visible answer identically (no existence disclosure);
    // a viewer without write authority gets Forbidden below.
    if (!secret || !(await canSeeSecretOwner(ctx, secret.ownerType as SecretOwnerType, secret.ownerId))) {
      throw new GraphQLError('Secret not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireSecretOwnerWrite(ctx, secret.ownerType as SecretOwnerType, secret.ownerId);

    if (args.metadata === undefined && args.value === undefined) {
      throw badInput('Pass metadata and/or value.');
    }
    const effectiveValue = args.value !== undefined ? args.value : decryptSecretValue(secret);
    const effectiveMetadata = args.metadata !== undefined ? args.metadata : secret.metadata;
    const { metadata, valueEncrypted } = validateAndEncryptSecret(
      secret.kind,
      effectiveMetadata,
      effectiveValue,
    );

    return ctx.db.secret.update({
      where: { id: secret.id },
      data: {
        metadata: metadata as never,
        valueEncrypted,
        updatedBy: ctx.userId ?? ctx.appId ?? null,
      },
    });
  },

  /**
   * Hard-delete a secret. Runs referencing the name fail their resolution
   * loud afterwards (or fall through to a less-specific scope of the same
   * name — the cascade contract).
   */
  deleteSecret: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const secret = await findSecretByRef(ctx, ref);
    if (!secret || !(await canSeeSecretOwner(ctx, secret.ownerType as SecretOwnerType, secret.ownerId))) {
      throw new GraphQLError('Secret not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireSecretOwnerWrite(ctx, secret.ownerType as SecretOwnerType, secret.ownerId);
    await ctx.db.secret.delete({ where: { id: secret.id } });
    return true;
  },
};

export const secretQueries = {
  /**
   * Fetch one secret (inspectable half only). Null for missing AND for
   * not-entitled — indistinguishable by design.
   */
  secret: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const secret = await findSecretByRef(ctx, ref);
    if (!secret) return null;
    if (!(await canSeeSecretOwner(ctx, secret.ownerType as SecretOwnerType, secret.ownerId))) return null;
    return secret;
  },

  /**
   * Paginated list for ONE owner scope (the `hadron secret ls` surface).
   * An unresolvable ref or a non-entitled owner yields an EMPTY page — no
   * existence disclosure (cor:api:100:01 posture).
   */
  secrets: async (
    _: unknown,
    args: {
      ownerType: string;
      ownerRef?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    const ownerType = assertOwnerType(args.ownerType);
    let ownerId: string;
    try {
      ownerId = await resolveSecretOwnerRef(ctx, ownerType, args.ownerRef);
    } catch {
      return { items: [], total: 0 };
    }
    if (!(await canSeeSecretOwner(ctx, ownerType, ownerId))) return { items: [], total: 0 };

    const where = { ownerType, ownerId };
    const take = clampListTake(args.limit);
    const [items, total] = await Promise.all([
      take === 0
        ? Promise.resolve([])
        : ctx.db.secret.findMany({
            where,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take,
            skip: Math.max(0, args.offset ?? 0),
          }),
      ctx.db.secret.count({ where }),
    ]);
    return { items, total };
  },
};
