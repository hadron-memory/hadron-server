/**
 * The registry of owner-limit keys (#5009). Adding a measure is one entry here and no schema change. Totals are counted when they are
 * asked for. Only `nodes` reads a stored figure (#5078): its answer must equal `countOwnerNodesOnDemand`, the truth.
 */
import { Prisma } from '../../generated/prisma/index.js';
import type { OwnerRef } from '../owner.js';

export type OwnerLimitKey = 'nodes' | 'memories' | 'agents' | 'apps' | 'assetBytes' | 'nodeBytes';
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

/**
 * Live nodes in every live memory of the owner, of any class, counted from the rows (#5009). A deleted memory keeps its node rows live, so
 * the memory must be live too. This is the figure the stored one must equal: the fallback, and the reference of every pin.
 */
export const countOwnerNodesOnDemand = (db: OwnerCountDb, owner: OwnerRef): Promise<bigint> => countOf(db, Prisma.sql`
  SELECT count(*) AS n FROM nodes n JOIN memories o ON o.id = n.memory_id
  WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL AND n.deleted_at IS NULL`);

/**
 * The same figure from the per-memory totals the triggers on `nodes` keep (#5078). The owner and the memory's liveness are joined here, so
 * a deleted, transferred or merged memory needs no write to the totals. The pending rows are this transaction's own (a commit folds
 * them in), so a check inside a writing transaction counts what it already wrote. The stored figure is only an input to this sum
 * (hrn:node:hadronmemory.com:specs:cor:acl:150:03): never serve it.
 */
const countOwnerNodesFromTotals = (db: OwnerCountDb, owner: OwnerRef): Promise<bigint> => countOf(db, Prisma.sql`
  SELECT COALESCE(sum(f.n), 0)::bigint AS n FROM (
    SELECT memory_id, live_nodes AS n FROM memory_node_totals
    UNION ALL SELECT memory_id, delta FROM memory_node_pending
  ) f JOIN memories o ON o.id = f.memory_id
  WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL`);

/** Read per call. Only the exact value `on-demand` goes back to counting the rows; anything else reads the totals. */
const nodesOnDemand = (): boolean => process.env.OWNER_NODE_COUNT_SOURCE === 'on-demand';

/** The order here is the order `ownerLimits` reports. */
export const OWNER_LIMIT_KEYS: Readonly<Record<OwnerLimitKey, OwnerLimitKeyDef>> = {
  nodes: {
    unitNoun: { one: 'node', many: 'nodes' },
    settable: true,
    count: (db, owner) => (nodesOnDemand() ? countOwnerNodesOnDemand : countOwnerNodesFromTotals)(db, owner),
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
  /**
   * #5018 (Billing A14, hrn:node:hadronmemory.com:specs:cor:dmo:060:18): the recorded size of the owner's nodes, each node's stored bytes
   * plus its revisions' (a node not measured yet counts zero), over live nodes in live memories, the join `nodes` uses. REPORT-ONLY: nothing
   * may limit it until the plan's section 13, item 6 is ruled, so no row and no deployment default may name it and nothing is refused.
   */
  nodeBytes: {
    unitNoun: { one: 'byte of node data', many: 'bytes of node data' },
    settable: false,
    count: (db, owner) => countOf(db, Prisma.sql`
      SELECT COALESCE(SUM(COALESCE(n.stored_bytes, 0)::bigint + COALESCE(n.revision_bytes, 0)), 0)::bigint AS n
      FROM nodes n JOIN memories o ON o.id = n.memory_id
      WHERE ${ownedBy(owner)} AND o.deleted_at IS NULL AND n.deleted_at IS NULL`),
  },
};

export const OWNER_LIMIT_KEY_LIST: readonly OwnerLimitKey[] = Object.keys(OWNER_LIMIT_KEYS) as OwnerLimitKey[];

export const isOwnerLimitKey = (key: string): key is OwnerLimitKey => Object.hasOwn(OWNER_LIMIT_KEYS, key);
export const isSettableOwnerLimitKey = (key: string): key is OwnerLimitKey => isOwnerLimitKey(key) && OWNER_LIMIT_KEYS[key].settable;
