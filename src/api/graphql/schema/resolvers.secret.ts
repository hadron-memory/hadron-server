import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { requireProtectedSecretHolder } from '../../../lib/secrets/protection.js';
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
import { autoDeleteLimitRefusal, deleteLockedAppSecret } from '../../../lib/secrets/autoDelete.js';
export { autoDeleteLimitRefusal } from '../../../lib/secrets/autoDelete.js';
import { GraphQLError } from 'graphql';
import { assertOneRevealPerOperation, type RevealOperationInfo } from '../../../lib/secrets/revealOperationGuard.js';
import { AUTHORIZATION_DENIED_CODE } from '../../../lib/auth/authorizationDenied.js';
import { pageArgs, pageEnvelope, type Context } from './resolvers.helpers.js';
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
  validateSecretPayload,
  validateUnchangedSecretMetadata,
  type SecretOwnerType,
} from '../../../lib/secrets.js';
import { forbiddenError } from '../../../lib/refusals.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { isAppRefResolutionFailure } from '../../../lib/auth/workerRead.js';
import { refNamesNothing } from '../../../lib/entityRef/refNamesNothing.js';
import { admitOperationRate } from '../../../lib/rateLimit/index.js';
import { transportRateIdentity } from '../../../lib/rateLimit/identity.js';
import {
  addAppSecretVersion,
  assertAppSecretRoom,
  lockSecretRow,
  recordSecretEvent,
  secretActorOf,
} from '../../../lib/secrets/appSecrets.js';
import { stageSecretChange, changeSnapshot, needsPasskey, deliverStaged } from '../../../lib/secrets/changeRequests.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { createPendingGrant, GrantCreateRefusal } from '../../../lib/grants/create.js';
import { requireSecretReadClientIssuer } from '../../../lib/secrets/readClientIssuer.js';
import { generateId } from '../../../lib/id.js';
import { revealWithReadClient } from '../../../lib/secrets/readClientReveal.js';
import { readClientPage, myReadClients } from '../../../lib/secrets/readClientList.js';
import { tickBatch } from './tickBatch.js';

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
        // #4893: the whole shared resolution list folds — a malformed ref is the same refusal.
        if (isAppRefResolutionFailure(err)) throw authorizationDenied();
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

import { loadLiveApp, appMember, appManager, requireAppMember, appAnchors } from '../../../lib/secrets/access.js';

/** The WRITES rate identity every App secret write admits under, shared with withdrawSecretChangeRequest (#4717 item 5). */
export function appRateIdentity(ctx: Context) {
  return ctx.limiterIdentity ?? transportRateIdentity(ctx as never);
}

/** The one duplicate-name refusal, for an ordinary create and a protected create refused at staging (#4717 item 3). */
function secretNameTaken(name: string): GraphQLError {
  return badInput(`A secret named "${name}" already exists at this scope.`);
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
  protected?: boolean;
  ownerType: string;
  ownerRef?: string | null;
  name: string;
  kind: string;
  metadata?: Record<string, unknown> | null;
  value: unknown;
}

export interface UpdateSecretArgs {
  protected?: boolean;
  ref: string;
  metadata?: Record<string, unknown> | null;
  value?: unknown;
}

export const secretMutations = {
  /** cor:sec:070:01-02: every protection transition requires the requester's own passkey. */
  setSecretProtected: async (_: unknown, { ref, protected: protect }: { ref: string; protected: boolean }, ctx: Context) => {
    await admitOperationRate(ctx, ctx.db, 'WRITES', appRateIdentity(ctx));
    const found = await findSecretByRef(ctx, ref);
    if (!found || found.ownerType !== 'app' || !(await canSeeSecretOwner(ctx, 'app', found.ownerId))) throw notFound();
    const app = await loadLiveApp(ctx, found.ownerId);
    if (!app) throw notFound();
    return deliverStaged(await withAuthorizedTx<SecretRow | GraphQLError>(ctx, appAnchors(app), async (txCtx) => {
      await requirePersonOnlyAct(txCtx, 'secret.change', needsPasskey);
      if (protect) await requireAppMember(txCtx, found.ownerId);
      else if (!(await appManager(txCtx, found.ownerId))) throw forbiddenError();
    }, async (tx) => {
      if (!(await lockSecretRow(tx, found.id))) throw notFound();
      const secret = await tx.secret.findUniqueOrThrow({ where: { id: found.id } });
      if (protect && secret.protected) throw badInput('Secret is already protected.');
      // #4717 item 8 (cor:sec:070:01): clearing protection that is not on changes nothing, so it stages no request and
      // spends no slot. Only whoever manages the App reaches this line (judged above), so no one else learns the state.
      if (!protect && !secret.protected) return secret;
      const latest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
      return stageSecretChange(tx, ctx, { appId: secret.ownerId, secretId: secret.id, name: secret.name, kind: secret.kind,
        metadata: secret.metadata, operation: protect ? 'SET_PROTECTED' : 'CLEAR_PROTECTED', snapshot: changeSnapshot(secret, latest?.versionNo ?? 0) });
    }));
  },
  /** Issue a read client for an App secret: a pending reveal grant and its client, made together (cor:sec:060:01). */
  revealSecret: (_: unknown, { clientId }: { clientId: string }, ctx: Context, info?: RevealOperationInfo) => revealSecretMutation(ctx, clientId, info),
  issueSecretReadClient: (_: unknown, { input }: { input: IssueReadClientInput }, ctx: Context) => issueSecretReadClient(ctx, input),

  /** Create a named, owner-scoped secret (gate per the matrix above). */
  createSecret: async (_: unknown, args: CreateSecretArgs, ctx: Context) => {
    const ownerType = assertOwnerType(args.ownerType);
    const ownerId = await resolveSecretOwnerRef(ctx, ownerType, args.ownerRef);
    const name = args.name.trim().toLowerCase();

    if (args.protected && ownerType !== 'app') throw badInput('Protection is available only for App secrets.');
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
        throw secretNameTaken(name);
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
    // An explicit null on a field that is not nullable in storage is "not supplied" (cor:api:210:01), as on the App door.
    const requestedProtected = args.protected ?? undefined;
    if (requestedProtected !== undefined) throw badInput('Protection is available only for App secrets.');

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

async function createAppSecret(ctx: Context, appId: string, name: string, args: CreateSecretArgs) {
  await admitOperationRate(ctx, ctx.db, 'WRITES', appRateIdentity(ctx));
  const app = await loadLiveApp(ctx, appId);
  if (!app) throw authorizationDenied();
  const actor = secretActorOf(ctx);
  try {
    return deliverStaged(await withAuthorizedTx<SecretRow | GraphQLError>(
      ctx,
      appAnchors(app),
      async (txCtx) => { await requireAppMember(txCtx, appId); },
      async (tx) => {
        if (!SECRET_NAME_RE.test(name)) {
          throw badInput('name must be lowercase [a-z0-9-], start alphanumeric, max 64 chars.');
        }
        const { metadata, valueJson, sizeBytes } = validateSecretPayload(args.kind, args.metadata, args.value);
        if (args.protected) {
          // #4717 item 3 (cor:sec:070:02): a taken name refuses at staging with the duplicate-name refusal, and nothing is
          // staged. Completion still rejudges the name, so one taken after staging ends the request stale.
          if (await tx.secret.findUnique({ where: { ownerType_ownerId_name: { ownerType: 'app', ownerId: appId, name } }, select: { id: true } })) {
            throw secretNameTaken(name);
          }
          return stageSecretChange(tx, ctx, { appId, secretId: null, name, kind: args.kind,
            metadata: metadata as never, operation: 'STORE', snapshot: 'absent', valueJson, sizeBytes, requireAppRoom: true });
        }
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
    ));
  } catch (err) {
    if (isSecretNameConflict(err)) {
      throw secretNameTaken(name);
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
  // A GraphQL null asks for no protection change, like an omitted argument.
  const requestedProtected = args.protected ?? undefined;
  if (args.metadata === undefined && args.value === undefined && requestedProtected === undefined) {
    throw badInput('Pass metadata and/or value.');
  }
  const actor = secretActorOf(ctx);
  const result = await withAuthorizedTx<SecretRow | GraphQLError>(
    ctx,
    appAnchors(app),
    async (txCtx) => {
      await requireAppMember(txCtx, found.ownerId);
      if (args.protected === false && !(await appManager(txCtx, found.ownerId))) throw forbiddenError();
    },
    async (tx) => {
      // The secret row's lock serializes stores: two racing value changes end at n+1 and n+2, never a duplicate or a gap.
      if (!(await lockSecretRow(tx, found.id))) throw notFound();
      const secret = await tx.secret.findUnique({ where: { id: found.id } });
      if (!secret) throw notFound();
      const effectiveMetadata = args.metadata !== undefined ? args.metadata : secret.metadata;
      const payload = args.value === undefined ? null : validateSecretPayload(secret.kind, effectiveMetadata, args.value, { enforceValueSize: true });
      const metadata = payload?.metadata ?? validateUnchangedSecretMetadata(secret.kind, effectiveMetadata, secret.metadata);
      // #4749: `protected: false` on an unprotected secret asks for no protection change. Judged after the manager gate above, so only a
      // manager reaches it; left as `false` it staged a request (a spent slot and a ceremony) for nothing.
      const protectedChange = !secret.protected && requestedProtected === false ? undefined : requestedProtected;
      if (!secret.protected && protectedChange === undefined && args.metadata === undefined && args.value === undefined) return secret; // the silent no-op: nothing to record
      if (secret.protected || protectedChange !== undefined) {
        const latest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
        return stageSecretChange(tx, ctx, { appId: secret.ownerId, secretId: secret.id, name: secret.name, kind: secret.kind,
          metadata: metadata as never, operation: 'STORE', snapshot: changeSnapshot(secret, latest?.versionNo ?? 0), valueJson: payload?.valueJson, sizeBytes: payload?.sizeBytes,
          protectedResult: protectedChange, writeVersion: args.value !== undefined });
      }
      let versionNo: number | null = null;
      if (payload) versionNo = await addAppSecretVersion(tx, secret, payload.valueJson, payload.sizeBytes, actor);
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
  if (result instanceof GraphQLError) throw result;
  return result;
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
  const result = await withAuthorizedTx<boolean | GraphQLError>(
    ctx,
    appAnchors(app),
    async (txCtx) => {
      const userId = await requirePersonOnlyAct(txCtx, 'secret.delete', found.protected ? needsPasskey : () => forbiddenError());
      const manager = (await appManager(txCtx, found.ownerId)) !== null;
      const creator = found.createdBy === userId && (await appMember(txCtx, found.ownerId)) !== null;
      if (!manager && !creator) throw forbiddenError();
    },
    async (tx) => {
      if (!(await lockSecretRow(tx, found.id))) throw notFound();
      const secret = await tx.secret.findUnique({ where: { id: found.id } });
      if (!secret) throw notFound();
      if (secret.protected) {
        const latest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
        return stageSecretChange(tx, ctx, { appId: secret.ownerId, secretId: secret.id, name: secret.name, kind: secret.kind,
          metadata: secret.metadata, operation: 'DELETE', snapshot: changeSnapshot(secret, latest?.versionNo ?? 0) });
      }
      await deleteLockedAppSecret(tx, secret, actor);
      return true;
    },
  );
  if (result instanceof GraphQLError) throw result;
  return result;
}

async function revealSecretMutation(ctx: Context, clientId: string, info?: RevealOperationInfo) {
  // R8: judged whole, before the rate limit or any read, so two fields in one operation are both refused and neither reads.
  assertOneRevealPerOperation(info);
  await admitOperationRate(ctx, ctx.db, 'CREDENTIALS', appRateIdentity(ctx));
  return revealWithReadClient(ctx, clientId);
}

/** The most live read clients one secret carries (#3998 plan R4): a bound on the list a manager reads and the grants a secret answers to. */
const MAX_LIVE_READ_CLIENTS = 100;

interface IssueReadClientInput {
  secretRef: string; holderKind: 'USER' | 'WORKER' | 'AGENT' | 'APP'; holderRef?: string | null; autoDelete: boolean;
  mode?: 'REVEAL' | 'USE' | null; bindingPrefix?: string | null; bindingHeader?: string | null;
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
  // The refusals that depend only on the INPUT come first, before the secret is looked up: judged after it, a stranger could tell an
  // existing secret from a missing one by which refusal came back (existence oracle, Rook's partial §10 at f610b2e5).
  // #4434: an AGENT holder is read through the role agent's live workers (cor:sec:060:02). A REVEAL client has no App holder (an App
  // reaches a secret only by use, from its own runs: S5, #4000), and a USE client is held by an agent or an App, never a person or a worker.
  // A read client nothing can read must never exist: refuse it before any write.
  const use = input.mode === 'USE';
  if (use ? (input.holderKind !== 'AGENT' && input.holderKind !== 'APP') : input.holderKind === 'APP') {
    throw readClientRefusal('GRANT_HOLDER_NOT_ALLOWED', use ? 'A use client is held by an agent or an App.' : 'A read client is held by a person, a worker or an agent.');
  }
  const startsAt = asTime(input.startsAt);
  const expiresAt = asTime(input.expiresAt);
  const maxUses = input.maxReads ?? null;
  const limitRefusal = autoDeleteLimitRefusal(input.autoDelete, expiresAt, maxUses);
  if (limitRefusal) throw readClientRefusal(limitRefusal.code, limitRefusal.message);
  const found = await findSecretByRef(ctx, input.secretRef);
  const denied = () => input.autoDelete ? readClientRefusal('SECRET_AUTO_DELETE_NOT_ALLOWED', 'You may not set an auto-delete mark for this secret.') : authorizationDenied();
  if (!found || found.ownerType !== 'app') throw denied();
  const app = await loadLiveApp(ctx, found.ownerId);
  if (!app) throw denied();
  // An agent holder is anchored under its own authority anchor, after the App's (every door orders them so), only if it exists and is not
  // deleted: an unknown id falls through to the one GRANT_HOLDER_NOT_ALLOWED inside the transaction (as createAsManager does).
  const agentAnchor = input.holderKind === 'AGENT' && typeof input.holderRef === 'string'
    && (await ctx.db.agent.findFirst({ where: { id: input.holderRef, deletedAt: null }, select: { id: true } })) ? input.holderRef : null;
  try {
    return await withAuthorizedTx(
      ctx,
      [...appAnchors(app), ...(agentAnchor ? [{ kind: 'agent' as const, id: agentAnchor }] : [])],
      async (txCtx) => {
        if (!(await lockSecretRow(txCtx.db as never, found.id))) throw authorizationDenied();
        await requireSecretReadClientIssuer(txCtx, found.id, input.autoDelete);
      },
      async (tx, txCtx) => {
        const userId = txCtx.userId as string;
        const issuance = await requireSecretReadClientIssuer({ ...txCtx, db: tx } as Context, found.id, input.autoDelete);
        const holder = input.holderKind === 'USER'
          ? { kind: 'user' as const, id: input.holderRef || userId }
          : input.holderKind === 'APP' ? { kind: 'app' as const, id: input.holderRef || app.id }
          : { kind: input.holderKind === 'AGENT' ? 'agent' as const : 'worker' as const, id: input.holderRef ?? '' };
        if (holder.kind === 'user' && !(await appMember({db:tx, userId:holder.id, roles:[]} as unknown as Context, app.id))) {
          throw readClientRefusal('GRANT_HOLDER_NOT_ALLOWED', 'A person holder must participate in this App.');
        }
        await requireProtectedSecretHolder(tx, found.id, userId, holder.kind === 'user' ? holder.id : null);
        const live = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM secret_read_clients c JOIN grants g ON g.id = c.grant_id
           WHERE c.secret_id = ${found.id} AND c.ended_at IS NULL AND g.revoked_at IS NULL AND g.holder_departed_at IS NULL`;
        if (Number(live[0]?.n ?? 0) >= MAX_LIVE_READ_CLIENTS) {
          throw readClientRefusal('SECRET_READ_CLIENT_LIMIT', 'This secret already has the most read clients it may have.');
        }
        const grantId = await createPendingGrant(tx, {
          appId: app.id, requester: { userId, workerId: null, sessionId: null }, holder,
          action: use ? 'secret.use' : 'secret.reveal',
          values: { secret: found.id, 'auto-delete': input.autoDelete ? 'delete' : 'keep', ...(use ? { 'binding-prefix': input.bindingPrefix, 'binding-header': input.bindingHeader } : {}) },
          startsAt, expiresAt, maxUses, reason: input.reason, canReadMemory: async () => false, heldAgentAnchor: agentAnchor,
        });
        const clientId = generateId();
        const selfIssued = holder.kind === 'user' && holder.id === userId;
        await tx.secretReadClient.create({
          data: { id: clientId, grantId, appId: app.id, secretId: found.id, secretName: issuance.secretName, issuerUserId: userId, selfIssued },
        });
        return { clientId, grantId, secretName: issuance.secretName, selfIssued, issuedToOwnWorker:null };
      },
    );
  } catch (error) {
    if (error instanceof GrantCreateRefusal) throw readClientRefusal(error.code, error.message);
    throw error;
  }
}

export const secretQueries = {
  mySecretReadClients: async (_: unknown, args: { limit?: number | null; offset?: number | null }, ctx: Context) => {
    // Callers that can never be a person get the empty answer before they reach the limiter, as before #3998 B.
    if (!ctx.userId || ctx.appKeyId || ctx.impersonation || isRunPrincipal(ctx)) return [];
    await admitOperationRate(ctx, ctx.db, 'OTHER_READS', appRateIdentity(ctx));
    return myReadClients(ctx, args);
  },

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
    } catch (e) {
      // #4893/#2975: a name-resolution failure on any owner arm — typed miss, malformed or
      // ambiguous ref — is the empty page, as is a typed refusal an arm already folded: the App
      // arm's one denial for missing-and-not-yours is authorizationDenied(), whose code (FORBIDDEN,
      // src/lib/auth/authorizationDenied.ts) is what this matches — while an App that resolves but
      // is not the caller's answers the same page below, at canSeeSecretOwner. Anything else —
      // argument validation, a database fault — is none of those and propagates: the bare catch
      // that used to swallow it made a dead database indistinguishable from an empty owner.
      if ((e instanceof GraphQLError && e.extensions?.code === AUTHORIZATION_DENIED_CODE) || refNamesNothing(e, { ambiguousNamesNothing: true })) {
        return { items: [], total: 0 };
      }
      throw e;
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
        : ctx.db.secretEvent.findMany({ where, orderBy: [{ at: 'desc' }, { seq: 'desc' }], take, skip: Math.max(0, args.offset ?? 0) }),
      ctx.db.secretEvent.count({ where }),
    ]);
    return { items, total };
  },
};

type VersionRow = { id: string; versionNo: number; sizeBytes: number; writtenAt: Date; writtenByUserId: string | null; writtenByWorkerId: string | null; supersededAt: Date | null };
type VersionsPageResult = { items: VersionRow[]; total: number };

/**
 * #4157: `Secret.currentVersion` of every App secret raised in the same tick shares ONE grouped query, not one
 * `findFirst` per parent. Keyed by the request Context (see `tickBatch`), so nothing outlives the tick. The newest
 * version is the max over ALL of a secret's versions, never derived from a paged subset.
 */
const currentVersionBatch = tickBatch<string, number | null>(async (ctx, ids) => {
  const rows = await ctx.db.secretVersion.groupBy({ by: ['secretId'], where: { secretId: { in: ids } }, _max: { versionNo: true } });
  return new Map(rows.map((r) => [r.secretId, r._max.versionNo ?? null]));
}, null);

/**
 * #4157: `Secret.versions` pages raised in the same tick share one grouped count and one lateral read (an index-bounded `LIMIT` per secret, via the unique `(secret_id, version_no)`) per distinct
 * (take, skip), so each parent keeps its own page and `hasMore`. The key is `<secretId>|<take>|<skip>`; a secret id
 * is a cuid, which cannot contain the separator.
 */
const versionsPageBatch = tickBatch<string, VersionsPageResult>(async (ctx, keys) => {
  const wanted = keys.map((k) => { const [id, take, skip] = k.split('|'); return { key: k, id, take: Number(take), skip: Number(skip) }; });
  const ids = [...new Set(wanted.map((w) => w.id))];
  const counts = await ctx.db.secretVersion.groupBy({ by: ['secretId'], where: { secretId: { in: ids } }, _count: { _all: true } });
  const total = new Map(counts.map((c) => [c.secretId, c._count._all]));
  const out = new Map<string, VersionsPageResult>();
  const windows = new Map<string, { take: number; skip: number; ids: string[] }>();
  for (const w of wanted) {
    out.set(w.key, { items: [], total: total.get(w.id) ?? 0 });
    if (w.take === 0) continue;
    const g = windows.get(`${w.take}|${w.skip}`) ?? { take: w.take, skip: w.skip, ids: [] };
    g.ids.push(w.id);
    windows.set(`${w.take}|${w.skip}`, g);
  }
  for (const g of windows.values()) {
    const rows = await ctx.db.$queryRaw<(VersionRow & { secretId: string })[]>`
      SELECT v.id, v.secret_id AS "secretId", v.version_no AS "versionNo", v.size_bytes AS "sizeBytes", v.written_at AS "writtenAt",
             v.written_by_user_id AS "writtenByUserId", v.written_by_worker_id AS "writtenByWorkerId", v.superseded_at AS "supersededAt"
        FROM unnest(${g.ids}::text[]) AS s(id)
        CROSS JOIN LATERAL (
          SELECT * FROM secret_versions x WHERE x.secret_id = s.id ORDER BY x.version_no DESC OFFSET ${g.skip} LIMIT ${g.take}
        ) v
       ORDER BY v.secret_id, v.version_no DESC`;
    for (const r of rows) {
      const { secretId, ...item } = r;
      out.get(`${secretId}|${g.take}|${g.skip}`)?.items.push(item);
    }
  }
  return out;
}, { items: [], total: 0 });

/** `Secret` field resolvers for the App half: versions are metadata only, newest first. Org and user secrets have none. */
export const secretFields = {
  /** Separate audience from Secret metadata: current issuer or manager; prefix-only for other managers. */
  readClients: async (s: { id: string; ownerType: string; ownerId: string }, args: { activeOnly?: boolean; limit?: number | null; offset?: number | null }, ctx: Context) => {
    // readClientPage's SQL joins apps and organizations, so liveness is judged there; appManager is false for a dead App.
    if (s.ownerType !== 'app') return pageEnvelope([], 0, 0);
    const manager = !!(await appManager(ctx, s.ownerId));
    return readClientPage(ctx, s.id, args, manager);
  },
  currentVersion: async (s: { id: string; ownerType: string }, _: unknown, ctx: Context) => {
    if (s.ownerType !== 'app') return null;
    return currentVersionBatch(ctx, s.id);
  },
  /** Paged (cor:api:120:04): default 20, cap 200, limit 0 counts only; `hasMore` says whether rows remain. */
  versions: async (
    s: { id: string; ownerType: string },
    args: { limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    if (s.ownerType !== 'app') return pageEnvelope([], 0, 0);
    const { take, skip } = pageArgs(args ?? {});
    const page = await versionsPageBatch(ctx, `${s.id}|${take}|${skip}`);
    return pageEnvelope(page.items, page.total, skip);
  },
};
