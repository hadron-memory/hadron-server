/**
 * The registry of owner-limit keys (#5009). Adding a measure is one entry here and no schema change. Totals are counted when they are
 * asked for. Only `nodes` reads a stored figure (#5078): its answer must equal `countOwnerNodesOnDemand`, the truth.
 */
import { Prisma } from '../../generated/prisma/index.js';
import type { OwnerRef } from '../owner.js';

export type OwnerLimitKey = 'nodes' | 'memories' | 'agents' | 'apps';
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
};

export const OWNER_LIMIT_KEY_LIST: readonly OwnerLimitKey[] = Object.keys(OWNER_LIMIT_KEYS) as OwnerLimitKey[];

export const isOwnerLimitKey = (key: string): key is OwnerLimitKey => Object.hasOwn(OWNER_LIMIT_KEYS, key);
export const isSettableOwnerLimitKey = (key: string): key is OwnerLimitKey => isOwnerLimitKey(key) && OWNER_LIMIT_KEYS[key].settable;
