/**
 * Removal of governed nodes through the generic surface.
 *
 * A governed node (`governedRole.ts`: a runnable task, a `review`, a `spec`
 * family role) is written through its kind's door, and the generic surfaces
 * refuse to touch it. Removal follows the same rule: a generic delete, a
 * recursive ancestor delete, a cascade or a merge fold that would remove one is
 * refused, judged over the WHOLE set of rows the operation removes, not only the
 * node the caller named. To remove a governed node, clear its marker through the
 * kind's update door first (its writer level applies there), then delete it as
 * an ordinary node. No new mutation and no bypass.
 *
 * Locking. The verdict is read under row locks, never from an earlier snapshot.
 * The affected rows are locked `FOR NO KEY UPDATE` in id order, which is what a
 * soft delete's own `UPDATE` and a marker edit (also an `UPDATE`) take, so:
 *   - a marker edit that commits before the lock is seen by the read below, and
 *   - a marker edit that arrives after the lock waits for the removal to commit.
 * Row locks, not an advisory key per row: a subtree has no cap, and one
 * advisory key per node would be an unbounded claim on the shared lock table
 * (the reason `bulkMutationGate.ts` declines to do it). The caller takes its
 * address locks first, so no row can join the set afterwards, and takes no
 * advisory key after these row locks, so this adds no lock-order inversion.
 *
 * Writer level. Removing a node writes it, so after the governed refusal the
 * generic delete doors judge every locked row's role and runnable state with
 * the shared predicate (cor:acl:130:07, `assertRoleWritersForNodes`), whose
 * rulebook lock comes after these row locks, as for any node write.
 *
 * The register stays the single source of truth: this module asks
 * `governedKindsOf`, it does not restate what makes a node governed.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { governedKindsOf, type GovernedKindEntry } from './governedRole.js';

/** How many governed locs a refusal names. The caller is already a writer of the memory. */
const NAMED_LOC_CAP = 10;

/** A governed row an operation would remove. */
export interface GovernedRemovalHit {
  id: string;
  loc: string;
  kinds: GovernedKindEntry[];
}

/** A row a removal locked, with the state its writer level and governed kind are judged on. */
export interface RemovalRow {
  id: string;
  loc: string;
  role: string | null;
  isRunnable: boolean | null;
}

/**
 * Lock the given node rows and return their state at that moment. Run inside
 * the removal's transaction, after its address locks and before its first
 * write; the row locks are held to commit, so the answer stays true through
 * the removal. The writer level (`assertRoleWritersForNodes`) is judged on
 * these rows, so its rulebook lock comes after them.
 *
 * `nodeIds` must all belong to `memoryId`. A row that has since left the memory
 * is ignored here; the caller's own concurrency checks own that case.
 */
export async function lockRemovalRows(
  tx: Prisma.TransactionClient,
  memoryId: string,
  nodeIds: readonly string[],
  opts: { hard?: boolean } = {},
): Promise<RemovalRow[]> {
  if (nodeIds.length === 0) return [];
  const ids = [...new Set(nodeIds)].sort();
  const rows = await tx.$queryRaw<Array<{ id: string; loc: string; role: string | null; is_runnable: boolean | null }>>`
    SELECT id, loc, role, is_runnable FROM nodes
    WHERE id = ANY(${ids}::text[]) AND memory_id = ${memoryId}
    ORDER BY id FOR NO KEY UPDATE`;
  // A hard delete's ON DELETE SET NULL writes every rule row (in any memory)
  // that references a removed node. A rule writer holds its row and then waits
  // for the rulebook exclusively, so these rows are locked here, before the
  // rulebook: nodes, then rules, then the rulebook, the order rule writers and
  // the GitHub sync take them in. A rule cannot start referencing a locked node
  // meanwhile: a rule writer takes its referenced nodes FOR SHARE first.
  if (opts.hard) {
    await tx.$queryRaw`
      SELECT id FROM node_role_rules
      WHERE description_node_id = ANY(${ids}::text[])
         OR author_task_id = ANY(${ids}::text[])
         OR validation_task_id = ANY(${ids}::text[])
      ORDER BY id FOR UPDATE`;
  }
  return rows.map((r) => ({ id: r.id, loc: r.loc, role: r.role, isRunnable: r.is_runnable }));
}

/** The governed rows among locked ones, by loc. */
export function governedAmong(rows: readonly RemovalRow[]): GovernedRemovalHit[] {
  return rows
    .map((r) => ({ id: r.id, loc: r.loc, kinds: governedKindsOf({ role: r.role, isRunnable: r.isRunnable }) }))
    .filter((r) => r.kinds.length > 0)
    .sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
}

/** Lock the given node rows, then return the ones that are governed at that moment ({@link lockRemovalRows}). */
export async function lockGovernedRowsIn(
  tx: Prisma.TransactionClient,
  memoryId: string,
  nodeIds: readonly string[],
): Promise<GovernedRemovalHit[]> {
  return governedAmong(await lockRemovalRows(tx, memoryId, nodeIds));
}

/**
 * Lock the given node rows, then refuse when any is governed. Returns the
 * locked rows, for the writer-level check that follows.
 *
 * @throws GraphQLError `ROLE_GOVERNED` (`op: 'delete'`, `refusal: 'removes'`).
 */
export async function assertNoGovernedRemoval(
  tx: Prisma.TransactionClient,
  memoryId: string,
  nodeIds: readonly string[],
  surface: 'graphql' | 'mcp' = 'graphql',
  opts: { hard?: boolean } = {},
): Promise<RemovalRow[]> {
  const rows = await lockRemovalRows(tx, memoryId, nodeIds, opts);
  const hits = governedAmong(rows);
  if (hits.length > 0) throw governedRemovalError(hits, surface);
  return rows;
}

/**
 * The refusal, in the `ROLE_GOVERNED` shape every governed-kind refusal uses so
 * clients handle it as one code. It names the way forward (clear the marker
 * through the kind's update door, then delete) and the governed locs, capped.
 * It is only reached by a caller who already passed the memory write gate, so it
 * names nothing a caller who cannot see the memory could learn from it.
 */
export function governedRemovalError(
  hits: readonly GovernedRemovalHit[],
  surface: 'graphql' | 'mcp' = 'graphql',
  act: 'delete' | 'overwrite' = 'delete',
): GraphQLError {
  const kinds = new Map<string, GovernedKindEntry>();
  for (const hit of hits) for (const kind of hit.kinds) kinds.set(kind.kind, kind);
  const first = [...kinds.values()][0]!;
  const named = hits.slice(0, NAMED_LOC_CAP).map((h) => h.loc);
  const more = hits.length > named.length ? ` (and ${hits.length - named.length} more)` : '';
  const multi = hits.some((h) => h.kinds.length > 1);
  const route = multi
    ? 'A node governed as more than one kind has no single door that can clear every marker, so it cannot be removed through any surface yet.'
    : [...kinds.values()]
        .map((k) => {
          const mcp = surface === 'mcp' && k.mcpDoors ? ` (over MCP, ${k.mcpDoors.update})` : '';
          return `${k.doors.update}${mcp} for ${k.kind === 'task' ? 'a runnable node' : `a ${k.kind}`}`;
        })
        .join('; ');
  const cli = surface === 'graphql' ? " From the CLI, `hadron node update` routes to the kind's door by itself." : '';
  const how = multi
    ? route
    : `To remove it, clear its governed marker through the kind's update door first (${route}), then ${act === 'overwrite' ? 'move over it' : 'delete it'} as an ordinary node.${cli}`;
  return new GraphQLError(
    `ROLE_GOVERNED: a generic ${act} cannot remove ${named.map((l) => `"${l}"`).join(', ')}${more}, ` +
      `which ${hits.length === 1 ? 'is a governed node' : 'are governed nodes'}. Nothing was changed. ${how}`,
    {
      extensions: {
        code: 'ROLE_GOVERNED',
        kind: first.kind,
        strength: first.strength,
        door: first.doors.update,
        mcpDoor: surface === 'mcp' && !multi ? (first.mcpDoors?.update ?? null) : null,
        op: act,
        refusal: 'removes',
        ...(kinds.size > 1 ? { kinds: [...kinds.keys()] } : {}),
        locs: named,
        count: hits.length,
      },
    },
  );
}
