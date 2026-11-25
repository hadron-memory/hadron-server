import type { Prisma } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from '../auth/liveOrgMembership.js';
import { acquireLockSet } from '../nodeSubtreeLock.js';
import { ownerId, ownerType, type OwnerRef } from '../owner.js';
import { ownerDefaultLimit } from './defaults.js';
import { OwnerLimitReachedError } from './errors.js';
import { OWNER_LIMIT_KEYS, type OwnerLimitKey } from './keys.js';

/** The `owner_limits` predicate of an owner. */
export const ownerLimitWhere = (owner: OwnerRef) =>
  'organizationId' in owner ? { organizationId: owner.organizationId } : { ownerUserId: owner.userId };

/** The limit in force: the owner's row (a null value lifts the default), else the default of the owner's type, else null (no limit). */
export const effectiveOwnerLimit = (owner: OwnerRef, key: OwnerLimitKey, row: { limitValue: bigint | null } | null): bigint | null =>
  row ? row.limitValue : ownerDefaultLimit(ownerType(owner), key);

async function readLimit(tx: Pick<Prisma.TransactionClient, 'ownerLimit'>, owner: OwnerRef, key: OwnerLimitKey): Promise<bigint | null> {
  const row = await tx.ownerLimit.findFirst({ where: { ...ownerLimitWhere(owner), key }, select: { limitValue: true } });
  return effectiveOwnerLimit(owner, key, row);
}

/**
 * Serialize on (owner, key) until the transaction ends. Several keys are locked in the order of their RESOLVED hash pairs, not of their
 * names: name order does not order hashed advisory keys, and two sets could deadlock (#1214). The prefix keeps these keys apart from the
 * `(memoryId, loc)` pairs of the same two-argument lock space; a hash collision only delays.
 */
export async function lockOwnerLimitKeys(tx: Prisma.TransactionClient, owner: OwnerRef, keys: readonly OwnerLimitKey[]): Promise<void> {
  const domain = `owner-limit:${ownerType(owner)}:${ownerId(owner)}`;
  await acquireLockSet(tx, keys.map((key) => ({ memoryId: domain, loc: key })));
}

/**
 * Refuse with `OWNER_LIMIT_REACHED` when `owner` has no room for `amount` more of `key` (#5009).
 *
 * Call it inside the writing transaction and BEFORE the write, as the LAST lock the door takes (after its subtree and authority locks), so
 * two doors cannot take them in opposite orders. A door that needs several keys takes `lockOwnerLimitKeys` for all of them first and then
 * calls this once per key. Where no limit applies it costs one indexed lookup: no lock and no count. No read, export, update or delete
 * path may call it.
 *
 * Isolation: READ COMMITTED is the intended one, because each statement after the lock wait then sees what the lock holder committed.
 * REPEATABLE READ is a programming error and throws a plain Error: its snapshot predates the wait. SERIALIZABLE is admitted, and there a
 * stale count is caught (40001, the caller's own retry decides) only against other SERIALIZABLE writers; a door that races a
 * READ COMMITTED door on the same key must therefore be READ COMMITTED too.
 *
 * `caller` is the person whose act this is, and null for an unattended writer. A door running under impersonation or for a headless run
 * passes null: the refusal then names no owner and no number.
 */
export async function requireOwnerHeadroom(
  tx: Prisma.TransactionClient,
  { owner, key, amount = 1n, caller, alreadyWritten = 0n }: {
    owner: OwnerRef; key: OwnerLimitKey; amount?: bigint; caller: { userId: string } | null;
    /**
     * #5015: how many of `amount` this transaction has ALREADY written, and so are in the count. Every door that judges
     * after a counted write must pass it, or those rows count twice: the GitHub sync (its net is known only at the end), a
     * merge batch (its rows are re-homed first) and the first createRevision (its parent). A refusal rolls the
     * transaction back. Never more than `amount`.
     */
    alreadyWritten?: bigint;
  },
): Promise<void> {
  if (amount < 0n) throw new Error('requireOwnerHeadroom: amount must not be negative');
  if (alreadyWritten < 0n || alreadyWritten > amount) throw new Error('requireOwnerHeadroom: alreadyWritten must be between 0 and amount');
  // Adding nothing is never refused, also for an owner already over the limit.
  if (amount === 0n) return;
  if ((await readLimit(tx, owner, key)) === null) return;
  const [{ isolation }] = await tx.$queryRaw<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
  if (isolation === 'repeatable read') {
    throw new Error('requireOwnerHeadroom must not run under REPEATABLE READ: the snapshot predates the lock wait');
  }
  await lockOwnerLimitKeys(tx, owner, [key]);
  // Again after the wait: a setOwnerLimits that held this lock may have changed or lifted the limit.
  const limit = await readLimit(tx, owner, key);
  if (limit === null) return;
  const used = await OWNER_LIMIT_KEYS[key].count(tx, owner);
  if (used - alreadyWritten + amount > limit) {
    throw new OwnerLimitReachedError({ key, owner, limit, callerCanManageOwner: await canManageOwner(tx, owner, caller) });
  }
}

/** The caller is the limited person, or a live OWNER or ADMIN of the limited organization. A platform role alone does not count. */
async function canManageOwner(
  tx: Pick<Prisma.TransactionClient, 'orgMember'>,
  owner: OwnerRef,
  caller: { userId: string } | null,
): Promise<boolean> {
  if (!caller) return false;
  if ('userId' in owner) return caller.userId === owner.userId;
  const member = await tx.orgMember.findFirst({
    where: { organizationId: owner.organizationId, userId: caller.userId, role: { in: ['OWNER', 'ADMIN'] }, ...LIVE_ORG_MEMBERSHIP },
    select: { userId: true },
  });
  return member !== null;
}
