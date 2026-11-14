/**
 * General-secret-store GraphQL surface (#677) — the write path backing the
 * v1 CLI (`hadron secret create/ls/rm`) plus the inspectable read surface.
 * The value is WRITE-ONLY: `valueEncrypted` is a column no field here ever
 * selects or exposes (redaction by construction — same posture as the
 * aiConfig / HA / Resend / MCP registries); `kind` + `metadata` are the
 * inspectable half. The row grants nothing by itself — run-time use walks
 * the cascade resolver under the run principal (src/lib/runner/secrets.ts).
 *
 * Authorization matrix (issue #677; #3997 added the App owner, cor:sec:020:02):
 *   owner    | create/update/delete                                  | see-it-exists (read surface)
 *   user     | that user (strict, no admin)                          | that user
 *   org      | org ADMIN                                              | org member
 *   app      | store/version: any App member; delete: creator or      | any App member (a person acting as
 *            | whoever manages the App, each as a person              | themselves; never an App key or an
 *            |                                                         | impersonated session)
 *
 * An App secret keeps NO value on its row: every store adds a version (src/lib/secrets/appSecrets.ts). The
 * memory-owned scope stays superseded (#696, D-2026-07-15-006).
 */
import { GraphQLError } from 'graphql';
import { pageArgs, pageEnvelope, type Context } from './resolvers.helpers.js';
import {
  clampListTake,
  isAppParticipant,
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
  validateSecretPayload,
  type SecretOwnerType,
} from '../../../lib/secrets.js';
import { forbiddenError } from '../../../lib/refusals.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AmbiguousLegacyUrnError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { admitOperationRate } from '../../../lib/rateLimit/index.js';
import { transportRateIdentity } from '../../../lib/rateLimit/identity.js';
import {
  addAppSecretVersion,
  assertAppSecretRoom,
  currentAppSecretValue,
  lockSecretRow,
  recordSecretEvent,
  secretActorOf,
} from '../../../lib/secrets/appSecrets.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { createPendingGrant, GrantCreateRefusal } from '../../../lib/grants/create.js';
import { requireSecretReadClientIssuer } from '../../../lib/secrets/readClientIssuer.js';
import { generateId } from '../../../lib/id.js';

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
    case 'app': {
      if (ownerRef == null) throw badInput('ownerRef is required for App-scoped secrets.');
      try {
        return (await resolveAppRef(ctx.db, ownerRef)).id;
      } catch (err) {
        // A missing App and one the caller may not use answer the same, so the ref is no existence oracle.
        if (err instanceof AppNotFoundError || err instanceof AmbiguousLegacyUrnError) throw authorizationDenied();
        throw err;
      }
    }
    default:
      return unknownOwnerType(ownerType);
  }
}

/** Every switch over the owner type ends here: a type none of its cases names is refused, never let through (#3997). */
function unknownOwnerType(_ownerType: never): never {
  throw forbiddenError();
}

type AppSecretRow = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The App when it is live (not deleted, not uninstalled); null otherwise. */
async function loadLiveApp(ctx: Context, appId: string): Promise<AppSecretRow | null> {
  const app = await ctx.db.app.findUnique({
    where: { id: appId },
    select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
  });
  if (!app || app.deletedAt || app.uninstalledAt) return null;
  return app;
}

/**
 * The caller as a MEMBER of a live App (cor:sec:020:02): a person acting as themselves who participates in the App. An
 * App key (no user), an impersonated session and a run are not members and see and change nothing. Returns the App row,
 * or null. A bound worker session is its driving person's session, so it passes when that person is a member.
 */
async function appMember(ctx: Context, appId: string): Promise<AppSecretRow | null> {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) return null;
  const app = await loadLiveApp(ctx, appId);
  if (!app) return null;
  return (await isAppParticipant(ctx, app)) ? app : null;
}

async function requireAppMember(ctx: Context, appId: string): Promise<AppSecretRow> {
  const app = await appMember(ctx, appId);
  if (!app) throw authorizationDenied();
  return app;
}

/** Whoever manages the live App, as a person acting as themselves (cor:dmo:050:12). */
async function appManager(ctx: Context, appId: string): Promise<AppSecretRow | null> {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) return null;
  const app = await loadLiveApp(ctx, appId);
  if (!app) return null;
  return (await managesApp(ctx, app)) ? app : null;
}

/** The authority anchors an App secret write depends on: the App, and its organization when it has one. */
function appAnchors(app: AppSecretRow) {
  return [
    { kind: 'app' as const, id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ];
}

function appRateIdentity(ctx: Context) {
  return ctx.limiterIdentity ?? transportRateIdentity(ctx as never);
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
    case 'app':
      // Any member stores or adds a version (cor:sec:020:02). Delete is narrower and decides for itself.
      await requireAppMember(ctx, ownerId);
      return;
    default:
      return unknownOwnerType(ownerType);
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
    case 'app':
      // A member sees that it exists; whoever manages the App does too (delete and listing). Never an App key,
      // an impersonated session or a run.
      return (await appMember(ctx, ownerId)) !== null || (await appManager(ctx, ownerId)) !== null;
    default:
      return unknownOwnerType(ownerType);
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
  /** Issue a read client for an App secret: a pending reveal grant and its client, made together (cor:sec:060:01). */
  issueSecretReadClient: (_: unknown, { input }: { input: IssueReadClientInput }, ctx: Context) => issueSecretReadClient(ctx, input),

  /** Create a named, owner-scoped secret (gate per the matrix above). */
  createSecret: async (_: unknown, args: CreateSecretArgs, ctx: Context) => {
    const ownerType = assertOwnerType(args.ownerType);
    const ownerId = await resolveSecretOwnerRef(ctx, ownerType, args.ownerRef);
    const name = args.name.trim().toLowerCase();

    if (ownerType === 'app') return createAppSecret(ctx, ownerId, name, args);

    await requireSecretOwnerWrite(ctx, ownerType, ownerId);
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
   * Change a secret's value and/or metadata. An org or user secret OVERWRITES (v1 rotation, no versions). An App
   * secret's value ADDS the next version and never overwrites (cor:sec:010:03). Name, kind, and owner are immutable:
   * flow config and the cascade reference the name, so renaming would silently orphan them. The effective
   * (metadata, value) pair is re-validated per kind, decrypting the stored value server-side when only metadata
   * changes, so the two halves can never drift apart.
   */
  updateSecret: async (_: unknown, args: UpdateSecretArgs, ctx: Context) => {
    const secret = await findSecretByRef(ctx, args.ref);
    // Missing and not-visible answer identically (no existence disclosure);
    // a viewer without write authority gets Forbidden below.
    if (!secret || !(await canSeeSecretOwner(ctx, secret.ownerType as SecretOwnerType, secret.ownerId))) {
      throw new GraphQLError('Secret not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (secret.ownerType === 'app') return updateAppSecret(ctx, secret, args);
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
      { enforceValueSize: args.value !== undefined },
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
   * Hard-delete a secret (every version with it). Runs referencing the name fail their resolution
   * loud afterwards (or fall through to a less-specific scope of the same
   * name — the cascade contract).
   */
  deleteSecret: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const secret = await findSecretByRef(ctx, ref);
    if (!secret || !(await canSeeSecretOwner(ctx, secret.ownerType as SecretOwnerType, secret.ownerId))) {
      throw new GraphQLError('Secret not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (secret.ownerType === 'app') return deleteAppSecret(ctx, secret);
    await requireSecretOwnerWrite(ctx, secret.ownerType as SecretOwnerType, secret.ownerId);
    await ctx.db.secret.delete({ where: { id: secret.id } });
    return true;
  },
};

type SecretRow = NonNullable<Awaited<ReturnType<typeof findSecretByRef>>>;

function notFound(): GraphQLError {
  return new GraphQLError('Secret not found.', { extensions: { code: 'NOT_FOUND' } });
}

/** A protected secret changes only through a person's change request (cor:sec:070:02, S4); until S4 every change refuses. */
function protectedRefusal(): GraphQLError {
  return new GraphQLError('This secret is protected: it changes only through a change request.', { extensions: { code: 'SECRET_PROTECTED' } });
}

async function createAppSecret(ctx: Context, appId: string, name: string, args: CreateSecretArgs) {
  await admitOperationRate(ctx, ctx.db, 'WRITES', appRateIdentity(ctx));
  const app = await loadLiveApp(ctx, appId);
  if (!app) throw authorizationDenied();
  const actor = secretActorOf(ctx);
  try {
    return await withAuthorizedTx(
      ctx,
      appAnchors(app),
      async (txCtx) => { await requireAppMember(txCtx, appId); },
      async (tx) => {
        if (!SECRET_NAME_RE.test(name)) {
          throw badInput('name must be lowercase [a-z0-9-], start alphanumeric, max 64 chars.');
        }
        const { metadata, valueJson, sizeBytes } = validateSecretPayload(args.kind, args.metadata, args.value);
        await assertAppSecretRoom(tx, appId);
        const secret = await tx.secret.create({
          data: {
            ownerType: 'app', ownerId: appId, name, kind: args.kind, metadata: metadata as never,
            valueEncrypted: null, createdBy: ctx.userId ?? null,
            createdByWorkerId: actor.workerId, createdBySessionId: actor.sessionId,
          },
        });
        const versionNo = await addAppSecretVersion(tx, secret, valueJson, sizeBytes, actor);
        await recordSecretEvent(tx, { ownerId: appId, secretId: secret.id, secretName: name, kind: 'STORE', versionNo, actor });
        return secret;
      },
    );
  } catch (err) {
    if (isSecretNameConflict(err)) {
      throw badInput(`A secret named "${name}" already exists at this scope.`);
    }
    throw err;
  }
}

/** A unique violation on the NAME. Any other one (the App key's own primary key under a race) is not a name clash and passes through. */
function isSecretNameConflict(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (e?.code !== 'P2002') return false;
  const target = e.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return /name/i.test(text);
}

async function updateAppSecret(ctx: Context, found: SecretRow, args: UpdateSecretArgs) {
  await admitOperationRate(ctx, ctx.db, 'WRITES', appRateIdentity(ctx));
  const app = await loadLiveApp(ctx, found.ownerId);
  if (!app) throw notFound();
  if (args.metadata === undefined && args.value === undefined) {
    throw badInput('Pass metadata and/or value.');
  }
  const actor = secretActorOf(ctx);
  return withAuthorizedTx(
    ctx,
    appAnchors(app),
    async (txCtx) => { await requireAppMember(txCtx, found.ownerId); },
    async (tx) => {
      // The secret row's lock serializes stores: two racing value changes end at n+1 and n+2, never a duplicate or a gap.
      if (!(await lockSecretRow(tx, found.id))) throw notFound();
      const secret = await tx.secret.findUnique({ where: { id: found.id } });
      if (!secret) throw notFound();
      if (secret.protected) throw protectedRefusal();
      const effectiveValue = args.value !== undefined ? args.value : await currentAppSecretValue(tx, secret);
      const effectiveMetadata = args.metadata !== undefined ? args.metadata : secret.metadata;
      const { metadata, valueJson, sizeBytes } = validateSecretPayload(secret.kind, effectiveMetadata, effectiveValue, {
        enforceValueSize: args.value !== undefined,
      });
      let versionNo: number | null = null;
      if (args.value !== undefined) versionNo = await addAppSecretVersion(tx, secret, valueJson, sizeBytes, actor);
      const updated = await tx.secret.update({
        where: { id: secret.id },
        data: { metadata: metadata as never, updatedBy: ctx.userId ?? null },
      });
      await recordSecretEvent(tx, {
        ownerId: secret.ownerId, secretId: secret.id, secretName: secret.name,
        kind: versionNo === null ? 'METADATA' : 'VERSION', versionNo, actor,
      });
      return updated;
    },
  );
}

/**
 * Delete an unprotected App secret (Holger's ruling R1 on open question 6, 2026-11-12): its CREATOR or whoever manages
 * the App, each as a PERSON (`requirePersonOnlyAct`: a worker session and a run are refused). A creator who has left the
 * App no longer qualifies (a revoked membership never authorizes). Every version goes with it, in the same transaction.
 */
async function deleteAppSecret(ctx: Context, found: SecretRow) {
  await admitOperationRate(ctx, ctx.db, 'WRITES', appRateIdentity(ctx));
  const app = await loadLiveApp(ctx, found.ownerId);
  if (!app) throw notFound();
  const actor = secretActorOf(ctx);
  return withAuthorizedTx(
    ctx,
    appAnchors(app),
    async (txCtx) => {
      const userId = await requirePersonOnlyAct(txCtx, 'secret.delete', () => forbiddenError());
      const manager = (await appManager(txCtx, found.ownerId)) !== null;
      const creator = found.createdBy === userId && (await appMember(txCtx, found.ownerId)) !== null;
      if (!manager && !creator) throw forbiddenError();
    },
    async (tx) => {
      if (!(await lockSecretRow(tx, found.id))) throw notFound();
      const secret = await tx.secret.findUnique({ where: { id: found.id } });
      if (!secret) throw notFound();
      if (secret.protected) throw protectedRefusal();
      const newest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
      await recordSecretEvent(tx, { ownerId: secret.ownerId, secretId: secret.id, secretName: secret.name, kind: 'DELETE', versionNo: newest?.versionNo ?? null, actor });
      await tx.secret.delete({ where: { id: secret.id } });
      return true;
    },
  );
}

/** The most live read clients one secret carries (#3998 plan R4): a bound on the list a manager reads and the grants a secret answers to. */
const MAX_LIVE_READ_CLIENTS = 100;

interface IssueReadClientInput {
  secretRef: string; holderKind: 'USER' | 'WORKER'; holderRef?: string | null; autoDelete: boolean;
  startsAt?: Date | string | null; expiresAt?: Date | string | null; maxReads?: number | null; reason: string;
}

function readClientRefusal(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

function asTime(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw badInput('A time is not a valid date.');
  return d;
}

/**
 * Issue a read client (cor:sec:060:01): the pending `secret.reveal` grant and its client row, in ONE transaction. Only a person
 * acting as themselves, who manages the App or wrote the current version (`requireSecretReadClientIssuer`, judged under the
 * secret row's lock so a newer version cannot slip in). The grant still needs the issuer's passkey signature, which judges the
 * issuer rule again. A client with an auto-delete mark needs a window or a read budget.
 */
async function issueSecretReadClient(ctx: Context, input: IssueReadClientInput) {
  await admitOperationRate(ctx, ctx.db, 'WRITES', appRateIdentity(ctx));
  const found = await findSecretByRef(ctx, input.secretRef);
  if (!found || found.ownerType !== 'app') throw authorizationDenied();
  const app = await loadLiveApp(ctx, found.ownerId);
  if (!app) throw authorizationDenied();
  const startsAt = asTime(input.startsAt);
  const expiresAt = asTime(input.expiresAt);
  const maxUses = input.maxReads ?? null;
  if (input.autoDelete && !expiresAt && maxUses === null) {
    throw readClientRefusal('SECRET_AUTO_DELETE_NEEDS_LIMIT', 'An auto-delete mark needs a window or a read budget.');
  }
  try {
    return await withAuthorizedTx(
      ctx,
      appAnchors(app),
      async (txCtx) => {
        if (!(await lockSecretRow(txCtx.db as never, found.id))) throw authorizationDenied();
        await requireSecretReadClientIssuer(txCtx, found.id);
      },
      async (tx, txCtx) => {
        const userId = txCtx.userId as string;
        const issuance = await requireSecretReadClientIssuer({ ...txCtx, db: tx } as Context, found.id);
        const holder = input.holderKind === 'USER'
          ? { kind: 'user' as const, id: userId }
          : { kind: 'worker' as const, id: input.holderRef ?? '' };
        if (input.holderKind === 'USER' && input.holderRef && input.holderRef !== userId) {
          throw readClientRefusal('GRANT_HOLDER_NOT_ALLOWED', 'A person holds a read client only for themself.');
        }
        const live = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM secret_read_clients c JOIN grants g ON g.id = c.grant_id
           WHERE c.secret_id = ${found.id} AND c.ended_at IS NULL AND g.revoked_at IS NULL AND g.holder_departed_at IS NULL`;
        if (Number(live[0]?.n ?? 0) >= MAX_LIVE_READ_CLIENTS) {
          throw readClientRefusal('SECRET_READ_CLIENT_LIMIT', 'This secret already has the most read clients it may have.');
        }
        const grantId = await createPendingGrant(tx, {
          appId: app.id, requester: { userId, workerId: null, sessionId: null }, holder,
          action: 'secret.reveal', values: { secret: found.id, 'auto-delete': input.autoDelete ? 'delete' : 'keep' },
          startsAt, expiresAt, maxUses, reason: input.reason, canReadMemory: async () => false,
        });
        const clientId = generateId();
        const selfIssued = holder.kind === 'user' && holder.id === userId;
        await tx.secretReadClient.create({
          data: { id: clientId, grantId, appId: app.id, secretId: found.id, secretName: issuance.secretName, issuerUserId: userId, selfIssued },
        });
        return { clientId, grantId, secretName: issuance.secretName, selfIssued };
      },
    );
  } catch (error) {
    if (error instanceof GrantCreateRefusal) throw readClientRefusal(error.code, error.message);
    throw error;
  }
}

export const secretQueries = {
  /**
   * Fetch one secret (inspectable half only). Null for missing AND for
   * not-entitled — indistinguishable by design.
   */
  secret: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const secret = await findSecretByRef(ctx, ref);
    if (!secret) return null;
    if (!(await canSeeSecretOwner(ctx, secret.ownerType as SecretOwnerType, secret.ownerId))) return null;
    if (secret.ownerType === 'app') await admitOperationRate(ctx, ctx.db, 'OTHER_READS', appRateIdentity(ctx));
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
    if (ownerType === 'app') await admitOperationRate(ctx, ctx.db, 'OTHER_READS', appRateIdentity(ctx));

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

  /**
   * The audit events of ONE App secret, newest first, for any MEMBER of the App (cor:sec:010:05, ruled 2026-11-14 by
   * Victor under 0265: a person acting as themselves, or a bound worker session in its own App). A non-member, an App
   * key, a run and an impersonated session get an EMPTY page, the same as a missing secret. Never a value.
   */
  secretEvents: async (
    _: unknown,
    args: { ref: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const empty = { items: [], total: 0 };
    const secret = await findSecretByRef(ctx, args.ref);
    if (!secret || secret.ownerType !== 'app') return empty;
    if (!(await appMember(ctx, secret.ownerId))) return empty;
    await admitOperationRate(ctx, ctx.db, 'OTHER_READS', appRateIdentity(ctx));
    const where = { ownerType: 'app', ownerId: secret.ownerId, secretId: secret.id };
    const take = clampListTake(args.limit);
    const [items, total] = await Promise.all([
      take === 0
        ? Promise.resolve([])
        : ctx.db.secretEvent.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take, skip: Math.max(0, args.offset ?? 0) }),
      ctx.db.secretEvent.count({ where }),
    ]);
    return { items, total };
  },
};

/** `Secret` field resolvers for the App half: versions are metadata only, newest first. Org and user secrets have none. */
export const secretFields = {
  currentVersion: async (s: { id: string; ownerType: string }, _: unknown, ctx: Context) => {
    if (s.ownerType !== 'app') return null;
    const row = await ctx.db.secretVersion.findFirst({ where: { secretId: s.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    return row?.versionNo ?? null;
  },
  /** Paged (cor:api:120:04): default 20, cap 200, limit 0 counts only; `hasMore` says whether rows remain. */
  versions: async (
    s: { id: string; ownerType: string },
    args: { limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    if (s.ownerType !== 'app') return pageEnvelope([], 0, 0);
    const { take, skip } = pageArgs(args ?? {});
    const where = { secretId: s.id };
    const [items, total] = await Promise.all([
      take === 0
        ? Promise.resolve([])
        : ctx.db.secretVersion.findMany({
            where,
            orderBy: { versionNo: 'desc' },
            take,
            skip,
            select: { id: true, versionNo: true, sizeBytes: true, writtenAt: true, writtenByUserId: true, writtenByWorkerId: true, supersededAt: true },
          }),
      ctx.db.secretVersion.count({ where }),
    ]);
    return pageEnvelope(items, total, skip);
  },
};
