// Owner limits (#5009, Billing A7a): what an owner may hold, how much of it is used, and the two platform-admin writes. The types are
// scalars only: `used` is a total over memories the reader may not be able to read, so no name and no id of one may join it.
import { GraphQLError } from 'graphql';
import { type Context, isPlatformAdmin, requireOrgRole } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { refHasUnstorableChars, refNamesNothing } from '../../../lib/entityRef/refNamesNothing.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { generateId } from '../../../lib/id.js';
import type { OwnerRef } from '../../../lib/owner.js';
import { limitText, logOwnerLimitChanges, NO_ROW, type OwnerLimitChange } from '../../../lib/ownerLimits/changes.js';
import { effectiveOwnerLimit, lockOwnerLimitKeys, ownerLimitWhere } from '../../../lib/ownerLimits/gate.js';
import {
  isOwnerLimitKey, isSettableOwnerLimitKey, OWNER_LIMIT_KEY_LIST, OWNER_LIMIT_KEYS, type OwnerLimitKey,
} from '../../../lib/ownerLimits/keys.js';
import type { Prisma, OwnerLimit } from '../../../generated/prisma/index.js';

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

const INT8_MAX = 9_223_372_036_854_775_807n;

interface OwnerArgs { orgRef?: string | null; userRef?: string | null }
interface SourceArgs { sourceType: string; sourceId: string; note: string; onlySourceType?: string | null }
interface SetInput extends OwnerArgs, SourceArgs { limits: Array<{ key: string; limit?: string | null }>; replace?: boolean | null }
interface ClearInput extends OwnerArgs, SourceArgs { keys?: string[] | null }

function assertOneOwner({ orgRef, userRef }: OwnerArgs): void {
  if ((orgRef == null) === (userRef == null)) throw badInput('Give exactly one of orgRef and userRef.');
}

async function resolveOwner(ctx: Context, { orgRef, userRef }: OwnerArgs): Promise<OwnerRef> {
  return orgRef != null
    ? { organizationId: (await resolveOrgRef(ctx.db, orgRef)).id }
    : { userId: (await resolveUserRef(ctx.db, userRef!)).id };
}

/** One row per registry key: the limit in force and the amount used, as base-10 strings. */
async function ownerUsage(ctx: Context, owner: OwnerRef) {
  const rows = new Map((await ctx.db.ownerLimit.findMany({ where: ownerLimitWhere(owner) })).map((r) => [r.key, r]));
  const out: Array<{ key: string; limit: string | null; used: string }> = [];
  for (const key of OWNER_LIMIT_KEY_LIST) {
    const limit = effectiveOwnerLimit(owner, key, rows.get(key) ?? null);
    out.push({ key, limit: limit === null ? null : limit.toString(), used: (await OWNER_LIMIT_KEYS[key].count(ctx.db, owner)).toString() });
  }
  return out;
}

/**
 * The person a `userRef` read is about. A platform admin may name anyone. Anyone else may name only themself, in their own session: not an
 * App key, not an impersonated session (an identity-scoped read, hrn:node:hadronmemory.com:specs:cor:acl:100:03) and not a run acting on
 * their behalf. Every other answer is the same refusal, whether or not the ref names someone.
 */
async function readableUser(ctx: Context, userRef: string): Promise<OwnerRef> {
  if (isPlatformAdmin(ctx)) return { userId: (await resolveUserRef(ctx.db, userRef)).id };
  if (!ctx.userId || ctx.impersonation || ctx.appKeyId || isRunPrincipal(ctx)) throw authorizationDenied();
  let id: string | null = null;
  try {
    ({ id } = await resolveUserRef(ctx.db, userRef));
  } catch (error) {
    if (!refNamesNothing(error)) throw error;
  }
  if (id !== ctx.userId) throw authorizationDenied();
  return { userId: id };
}

/** Who may write limits. One predicate, judged on the request and again in the transaction (#5012 widens it to the billing role). */
function requireLimitWriter(ctx: Context): void {
  if (!isPlatformAdmin(ctx)) throw authorizationDenied();
}

function assertSource(input: SourceArgs): void {
  for (const field of ['sourceType', 'sourceId', 'note', 'onlySourceType'] as const) {
    const value = input[field];
    if (value == null && field === 'onlySourceType') continue;
    if (!value?.trim() || refHasUnstorableChars(value)) throw badInput(`${field} must not be blank or hold an unstorable character.`);
  }
}

function assertUnique(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) throw badInput('A key may be named only once.');
}

function parseLimit(raw: string | null | undefined): bigint | null {
  if (raw == null) return null;
  const value = /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
  if (value === null || value > INT8_MAX) throw badInput('limit must be a non-negative base-10 integer string, or null for unlimited.');
  return value;
}

/** The transaction both writes share: the owner is live, the caller still may, and every key this call may touch is locked. */
async function writeOwnerLimits(
  ctx: Context,
  owner: OwnerRef,
  keys: readonly OwnerLimitKey[],
  write: (tx: Prisma.TransactionClient, rows: OwnerLimit[]) => Promise<OwnerLimitChange[]>,
) {
  const anchor = 'organizationId' in owner ? { kind: 'org' as const, id: owner.organizationId } : { kind: 'user' as const, id: owner.userId };
  const changes = await withAuthorizedTx(
    ctx,
    [anchor],
    async (txCtx) => requireLimitWriter(txCtx),
    async (tx) => {
      await lockOwnerLimitKeys(tx, owner, keys);
      return write(tx, await tx.ownerLimit.findMany({ where: ownerLimitWhere(owner), orderBy: { key: 'asc' } }));
    },
  );
  logOwnerLimitChanges(ctx.userId ?? ctx.clientId ?? null, changes);
  // Counted after the commit, so a count over a large owner never runs inside the locks its writers wait on.
  return ownerUsage(ctx, owner);
}

async function removeRows(tx: Prisma.TransactionClient, owner: OwnerRef, rows: readonly OwnerLimit[], input: SourceArgs): Promise<OwnerLimitChange[]> {
  if (rows.length > 0) await tx.ownerLimit.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return rows.map((r) => ({
    owner, key: r.key, oldLimit: limitText(r.limitValue), newLimit: NO_ROW, origin: { sourceType: input.sourceType, sourceId: input.sourceId },
  }));
}

export const ownerLimitQueries = {
  ownerLimits: async (_: unknown, args: OwnerArgs, ctx: Context) => {
    assertOneOwner(args);
    if (args.orgRef != null) {
      const { id } = await resolveOrgRef(ctx.db, args.orgRef);
      await requireOrgRole(ctx, id, 'ADMIN');
      return ownerUsage(ctx, { organizationId: id });
    }
    return ownerUsage(ctx, await readableUser(ctx, args.userRef!));
  },
};

export const ownerLimitMutations = {
  /** Upsert the named keys; with `replace`, also delete the owner's other rows (only those of `onlySourceType` when given). */
  setOwnerLimits: async (_: unknown, { input }: { input: SetInput }, ctx: Context) => {
    requireLimitWriter(ctx);
    assertOneOwner(input);
    assertSource(input);
    if (input.onlySourceType != null && !input.replace) throw badInput('onlySourceType narrows replace, so it needs replace: true.');
    assertUnique(input.limits.map((l) => l.key));
    const wanted = input.limits.map(({ key, limit }) => {
      if (!isSettableOwnerLimitKey(key)) throw badInput('A key is not one that can be limited.');
      return { key, limitValue: parseLimit(limit) };
    });
    const owner = await resolveOwner(ctx, input);
    const actor = ctx.userId ?? ctx.clientId ?? null;
    const origin = { sourceType: input.sourceType, sourceId: input.sourceId };
    return writeOwnerLimits(ctx, owner, input.replace ? OWNER_LIMIT_KEY_LIST : wanted.map((w) => w.key), async (tx, rows) => {
      const changes: OwnerLimitChange[] = [];
      const named = new Set<string>();
      for (const { key, limitValue } of wanted) {
        named.add(key);
        const data = { limitValue, ...origin, note: input.note, updatedBy: actor };
        const row = rows.find((r) => r.key === key);
        // Find-then-write is safe here: the (owner, key) lock is held, and both writes take it.
        if (row) await tx.ownerLimit.update({ where: { id: row.id }, data });
        else await tx.ownerLimit.create({ data: { id: generateId(), ...ownerLimitWhere(owner), key, ...data, createdBy: actor } });
        if (!row || row.limitValue !== limitValue) {
          changes.push({ owner, key, oldLimit: row ? limitText(row.limitValue) : NO_ROW, newLimit: limitText(limitValue), origin });
        }
      }
      if (!input.replace) return changes;
      const unnamed = rows.filter((r) => !named.has(r.key) && (input.onlySourceType == null || r.sourceType === input.onlySourceType));
      return [...changes, ...(await removeRows(tx, owner, unnamed, input))];
    });
  },

  /** Delete the named keys' rows, or every row when `keys` is omitted, so the deployment default applies again. */
  clearOwnerLimits: async (_: unknown, { input }: { input: ClearInput }, ctx: Context) => {
    requireLimitWriter(ctx);
    assertOneOwner(input);
    assertSource(input);
    let keys: readonly OwnerLimitKey[] | null = null;
    if (input.keys) {
      // An empty list is refused: it must not read as "every key".
      if (input.keys.length === 0) throw badInput('keys must name a key, or be omitted to clear every key.');
      assertUnique(input.keys);
      if (!input.keys.every(isOwnerLimitKey)) throw badInput('A key is unknown.');
      keys = input.keys;
    }
    const owner = await resolveOwner(ctx, input);
    return writeOwnerLimits(ctx, owner, keys ?? OWNER_LIMIT_KEY_LIST, (tx, rows) =>
      removeRows(tx, owner, rows.filter((r) =>
        (!keys || (keys as readonly string[]).includes(r.key)) && (input.onlySourceType == null || r.sourceType === input.onlySourceType)), input));
  },
};
