/**
 * General-secret-store GraphQL surface (#677) — the write path backing the
 * v1 CLI (`hadron secret create/ls/rm`) plus the inspectable read surface.
 * The value is WRITE-ONLY: `valueEncrypted` is a column no field here ever
 * selects or exposes (redaction by construction — same posture as the
 * aiConfig / HA / Resend / MCP registries); `kind` + `metadata` are the
 * inspectable half. The row grants nothing by itself — run-time use walks
 * the cascade resolver under the run principal (src/lib/runner/secrets.ts).
 *
 * Authorization matrix (issue #677; owners narrowed to org/user in #696):
 *   owner    | create/update/delete            | see-it-exists (read surface)
 *   user     | that user (strict, no admin)    | that user
 *   org      | org ADMIN                        | org member
 *
 * The #679 app- and memory-owned scopes are superseded (#696,
 * D-2026-07-15-006): the flat v2 secret URN carries a single root principal.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import {
  clampListTake,
  isOrgMemberOrAdmin,
  requireOrgRole,
} from './resolvers.helpers.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { resolveSecretRef } from '../../../lib/entityRef/secretRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { SecretNotFoundError } from '../../../lib/entityRef/errors.js';
import {
  decryptSecretValue,
  isSecretOwnerType,
  SECRET_NAME_RE,
  SECRET_OWNER_TYPES,
  validateAndEncryptSecret,
  type SecretOwnerType,
} from '../../../lib/secrets.js';
import { forbiddenError } from '../../../lib/refusals.js';

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

function assertOwnerType(value: unknown): SecretOwnerType {
  if (!isSecretOwnerType(value)) {
    throw badInput(`ownerType must be one of: ${SECRET_OWNER_TYPES.join(', ')}.`);
  }
  return value;
}

/**
 * Resolve a secret ref — a cuid id OR an `hrn:secret:…` URN (#683) — to its
 * full row, or null when it names an absent owner or secret. Follows the
 * repo's ref-resolution convention (cf. `Query.agent`): only genuine
 * not-found is masked to `null`; a malformed/under-qualified URN surfaces its
 * `UrnNotQualifiedError`, and operational/DB errors propagate rather than
 * reading as "not found". A cuid is looked up directly (no double query).
 */
async function findSecretByRef(ctx: Context, ref: string) {
  if (isId(ref)) {
    return ctx.db.secret.findUnique({ where: { id: ref } });
  }
  let id: string;
  try {
    ({ id } = await resolveSecretRef(ctx.db, ref));
  } catch (err) {
    if (err instanceof SecretNotFoundError) return null;
    throw err;
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
        if (!ctx.userId) throw forbiddenError();
        return ctx.userId;
      }
      return (await resolveUserRef(ctx.db, ownerRef)).id;
    }
    case 'org': {
      if (ownerRef == null) throw badInput('ownerRef is required for org-scoped secrets.');
      return (await resolveOrgRef(ctx.db, ownerRef)).id;
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
      throw forbiddenError();
    }
    case 'org': {
      await requireOrgRole(ctx, ownerId, 'ADMIN');
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
      // #876 class sweep: a user-scoped secret is identity-scoped — the
      // target owning it does not admit an impersonated session. (Org-scoped
      // secrets stay reachable via isOrgMemberOrAdmin, which is narrowed.)
      return !!ctx.userId && ctx.userId === ownerId && !ctx.impersonation;
    case 'org':
      return isOrgMemberOrAdmin(ctx, ownerId);
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
