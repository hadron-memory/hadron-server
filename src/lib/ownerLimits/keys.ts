/**
 * The registry of owner-limit keys (#5009). Adding a measure is one entry here and no schema change. Totals are counted when they are
 * asked for; there is no cache and no stored counter.
 */
import { Prisma } from '../../generated/prisma/index.js';
import type { OwnerRef } from '../owner.js';

export type OwnerLimitKey = 'nodes' | 'memories' | 'agents' | 'apps' | 'assetBytes';
/** What a count needs: the plain client or a transaction. */
export type OwnerCountDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface OwnerLimitKeyDef {
  readonly unitNoun: { readonly one: string; readonly many: string };
  /** False for a key that is only reported: neither a row nor the deployment default may limit it. */
  readonly settable: boolean;
  count(db: OwnerCountDb, owner: OwnerRef): Promise<bigint>;
}

/** The owner predicate on a table (or alias) that stores `organization_id` XOR `owner_user_id`. The column is a constant, never input. */
function ownedBy(owner: OwnerRef): Prisma.Sql {
  return 'organizationId' in owner
    ? Prisma.sql`o.organization_id = ${owner.organizationId}`
    : Prisma.sql`o.owner_user_id = ${owner.userId}`;
}

async function countOf(db: OwnerCountDb, query: Prisma.Sql): Promise<bigint> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>(query);
  return row.n;
}

/** The order here is the order `ownerLimits` reports. */
export const OWNER_LIMIT_KEYS: Readonly<Record<OwnerLimitKey, OwnerLimitKeyDef>> = {
  /** Live nodes in every live memory of the owner, of any class. A deleted memory keeps its node rows live, so the memory must be live too. */
  nodes: {
    unitNoun: { one: 'node', many: 'nodes' },
    settable: true,
    count: (db, owner) => countOf(db, Prisma.sql`
      SELECT count(*) AS n FROM nodes n JOIN memories o ON o.id = n.memory_id
      WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL AND n.deleted_at IS NULL`),
  },
  /** Free-standing memories of the four user-made classes. A memory inside an App, an install memory and a system memory are free. */
  memories: {
    unitNoun: { one: 'memory', many: 'memories' },
    settable: true,
    count: (db, owner) => countOf(db, Prisma.sql`
      SELECT count(*) AS n FROM memories o
      WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL AND o.app_id IS NULL AND o.is_install_memory = false
        AND o.class IN ('knowledge', 'group', 'personal', 'private')`),
  },
  agents: {
    unitNoun: { one: 'agent', many: 'agents' },
    settable: true,
    count: (db, owner) => countOf(db, Prisma.sql`SELECT count(*) AS n FROM agents o WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL`),
  },
  apps: {
    unitNoun: { one: 'app', many: 'apps' },
    settable: true,
    count: (db, owner) => countOf(db, Prisma.sql`SELECT count(*) AS n FROM apps o WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL`),
  },
  /**
   * #5017 (A10): the bytes of the owner's files, as a 64-bit sum, counted until they are reclaimed. A file counts while its row is attached
   * to a memory of the owner and is neither soft-deleted nor BLOCKED; a file still being scanned (PENDING) counts. A soft-deleted MEMORY's
   * files still count (re-gate on #5017): deleting a memory touches no asset row, so nothing reclaims those bytes, and excluding them would
   * let an owner cycle the cap by delete-and-refill. A file's own soft delete is excluded, because the janitor reclaims it after its window.
   * The size is the declared one (capped by the per-file limit), so this is a cap and not an invoice figure. A staged file with no memory
   * has no owner and counts for nobody.
   */
  assetBytes: {
    unitNoun: { one: 'byte of files', many: 'bytes of files' },
    settable: true,
    count: (db, owner) => countOf(db, Prisma.sql`
      SELECT COALESCE(sum(a.size_bytes), 0)::bigint AS n FROM assets a JOIN memories o ON o.id = a.memory_id
      WHERE ${ownedBy(owner)} AND a.deleted_at IS NULL AND a.scan_status <> 'BLOCKED'`),
  },
};

export const OWNER_LIMIT_KEY_LIST: readonly OwnerLimitKey[] = Object.keys(OWNER_LIMIT_KEYS) as OwnerLimitKey[];

export const isOwnerLimitKey = (key: string): key is OwnerLimitKey => Object.hasOwn(OWNER_LIMIT_KEYS, key);
export const isSettableOwnerLimitKey = (key: string): key is OwnerLimitKey => isOwnerLimitKey(key) && OWNER_LIMIT_KEYS[key].settable;
