/**
 * resolveNodeRef — convert an inbound node reference string to a
 * definite node ID. See `memoryRef.ts` for the broader convention.
 *
 * Spec: 007-entity-id-or-urn (extension to nodes for spec 005 graph
 * traversal callers — primarily edges), amended by spec 022 (URN
 * qualification at the API boundary).
 *
 * Accepted forms:
 *   - `<id>`                                    bare ID (cuid or 32-hex)
 *   - `urn:node:<memory-urn>:<loc>`             prefixed full URN
 *   - `<memory-urn>:<loc>`                      bare full URN (e.g.
 *                                                 `acme.com:mmdata:services:db-model-helper`)
 *   - `<loc>`                                   short loc — resolved
 *                                                 within `contextMemoryId`
 *
 * `contextMemoryId` is the memory the caller "is in" — typically the
 * source node's memory when resolving an outgoing edge target. Short
 * locs resolve relative to it; full URNs resolve against the memory
 * named in the URN (which may differ from the context memory — that
 * supports cross-memory edges).
 *
 * **API-boundary discipline (spec 022 FR-007a)**: GraphQL resolvers,
 * MCP tool handlers, and `hadron-client` SDK call sites MUST NOT pass
 * `contextMemoryId` — doing so would re-introduce the silent-routing
 * bug spec 022 closed (an API-boundary caller passing
 * `session.activeMemoryUrn` here would let a relative-form node URN
 * dispatch to the active memory). The bare-loc-within-context branch
 * is preserved ONLY for internal callers (graph traversal already
 * operating inside a known memory). When `contextMemoryId` is omitted,
 * the URN-input branch enforces `assertFullyQualifiedUrn` and the
 * bare-loc branch is unreachable.
 *
 * Throws `NodeNotFoundError` for any unresolvable ref. Throws
 * `UrnNotQualifiedError` when a non-ID, non-context-relative input
 * lacks the org+memory+loc shape. Soft-deleted nodes are treated as
 * not-existing — including a node reached through a soft-deleted memory
 * prefix. Pass `{ includeDeleted: true }` to ignore soft-delete state along
 * the whole resolution path (the target node AND the memory that locates it),
 * matching `memoryRef`'s opt-in (e.g. a `deleteNode` re-delete for idempotency).
 *
 * Why this lives next to `memoryRef.ts` and friends: spec 007's
 * resolution-helpers contract is the single place callers go to turn
 * an inbound entity-ref string into a definite ID. This adds nodes to
 * that contract so edge-target resolution gets the same uniform shape
 * the memory/agent/app refs already have, instead of each caller (the
 * upsertNode resolver, MCP shims) inventing its own one-off lookup.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn } from '../urn.js';
import { findLiveUrnAliasTargets } from '../urnAlias.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from './errors.js';

/**
 * Resolve a node's old composed address after the live memory/loc lookup
 * missed. Alias rows carry no authority: re-query current node and memory
 * liveness, then leave caller-specific content access to the caller's gate.
 */
async function findMovedNodes(
  db: Pick<PrismaClient, 'node' | 'urnAlias'>,
  bareUrns: readonly string[],
  includeDeleted = false,
): Promise<Array<{ id: string }>> {
  const live = new Map<string, { id: string }>();
  for (const bareUrn of new Set(bareUrns)) {
    const rows = await findLiveUrnAliasTargets(db, 'NODE', bareUrn, (ids) =>
      db.node.findMany({
        where: {
          id: { in: ids },
          ...(includeDeleted ? {} : { deletedAt: null, memory: { deletedAt: null } }),
        },
        select: { id: true },
      }),
      { all: true },
    );
    for (const row of rows) live.set(row.id, row);
  }
  return [...live.values()];
}

/** Find every live historical holder of one memory prefix before checking nodes. */
async function findHistoricalMemories(
  db: Pick<PrismaClient, 'memory' | 'urnAlias'>,
  urns: readonly string[],
  includeDeleted = false,
): Promise<Array<{ id: string; urn: string }>> {
  for (const urn of urns) {
    const rows = await findLiveUrnAliasTargets(db, 'MEMORY', urn, (ids) =>
      db.memory.findMany({
        where: { id: { in: ids }, ...(includeDeleted ? {} : { deletedAt: null }) },
        select: { id: true, urn: true },
      }),
      { all: true },
    );
    if (rows.length) return rows;
  }
  return [];
}

/**
 * An ambiguous lookup is a visible refusal only if this caller can read at
 * least one current claimant. The resolver itself has no principal or gate;
 * every transport must apply its own node-content read predicate before
 * exposing the ambiguity (cor:urn:030:02, cor:api:140:03).
 */
export async function isConcealedNodeRefAmbiguity(
  db: Pick<PrismaClient, 'node'>,
  error: unknown,
  canReadMemoryId: (memoryId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!(error instanceof AmbiguousLegacyUrnError) || !error.candidateNodeIds) return false;
  const claimants = await db.node.findMany({
    where: {
      id: { in: [...error.candidateNodeIds] }, deletedAt: null,
      memory: { deletedAt: null },
    },
    select: { memoryId: true },
  });
  for (const memoryId of new Set(claimants.map((n) => n.memoryId))) {
    if (await canReadMemoryId(memoryId)) return false;
  }
  return true;
}

export async function resolveNodeRef(
  db: Pick<PrismaClient, 'node' | 'memory' | 'urnAlias'>,
  ref: string,
  contextMemoryId?: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  // Form 1: bare ID — no URN parsing needed; look up by PK directly. This is a
  // single unique lookup (like the sibling resolvers), so the soft-delete
  // exclusion lives in the query: findFirst + `deletedAt: null` unless
  // includeDeleted. (The URN paths below keep post-fetch checks because their
  // memory lookup gates control flow.)
  if (isIdFunc(ref)) {
    const node = await db.node.findFirst({
      where: { id: ref, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
      select: { id: true },
    });
    if (!node) throw new NodeNotFoundError(ref);
    return { id: node.id };
  }

  const parsed = parseUrnInput(ref);

  // A wrong-type URN prefix (e.g. `urn:memory:...`, `urn:org:...`)
  // is a coercion bug — fail loudly rather than silently lookup the
  // bare value.
  if (parsed.type !== 'unknown' && parsed.type !== 'node' && parsed.type !== 'loc') {
    throw new NodeNotFoundError(ref);
  }
  const normalized = parsed.value;
  // An explicit `urn:node:` prefix declares "this is a full node URN".
  // We resolve it strictly: the body must have the `<memory-urn>:<loc>`
  // shape and the named memory must be live. We never silently fall
  // through to short-loc resolution within `contextMemoryId`, because
  // that could mis-resolve to a same-shaped loc in the context memory
  // when the caller's intent was unambiguously the named memory.
  const strictUrnNode = parsed.type === 'node';

  // A prefixed input whose body is a bare ID (e.g. `urn:node:<id>`) is not a
  // valid node-URN shape — node URNs are always `<memory-urn>:<loc>`. (An
  // unprefixed bare ID was already handled above.) Reject rather than silently
  // looking it up.
  if (isIdFunc(normalized)) {
    throw new NodeNotFoundError(ref);
  }

  // Spec 022 enforcement: API-boundary callers MUST NOT pass
  // `contextMemoryId`. When it's absent, the input MUST be a fully-
  // qualified node URN (`org:memory:loc` minimum). The bare-loc-within-
  // context branch is unreachable in that case — relative-form inputs
  // throw UrnNotQualifiedError here rather than silently routing
  // through the (no-longer-supplied) context memory.
  if (contextMemoryId === undefined) {
    assertFullyQualifiedUrn(ref, 'node');
  }

  // Form 2/3: full URN `<memory-urn>:<loc>`. Memory URNs are always
  // exactly two segments (`<orgUrn>:<memoryName>`) per the URN-format
  // convention, so a 3+-segment input MAY be a full-URN-prefixed loc.
  // For explicit `urn:node:` inputs we require this shape; for
  // unprefixed inputs we treat it as such only if the 2-segment prefix
  // actually names a live memory (otherwise fall through to short-loc
  // resolution, which preserves short locs that legitimately contain
  // colons).
  //
  // Issue #183: prefer canonical `::` as the hierarchy separator (spec
  // 021 D2). When the input contains `::`, split on `::` so the
  // memory/loc boundary is unambiguous regardless of any `:` atoms
  // inside the loc itself (e.g. `chats:vocabulary`). Fall back to
  // single-`:` for legacy / pre-021 inputs still in flight. Without
  // this, canonical-form URNs that `hadron_get_node` happily accepts
  // (because it routes through `splitNodeUrn`) silently failed as
  // edge targets — the colon-naive `.split(':')` produced empty
  // segments, the memory lookup missed, and the resolver fell
  // through to short-loc resolution against `contextMemoryId` (where
  // it failed again).
  const isCanonical = normalized.includes('::');
  const parts = isCanonical ? normalized.split('::') : normalized.split(':');
  if (parts.length >= 3) {
    // Canonical (`::`) input: the LOC is the FINAL `::`-leaf (locs never
    // contain `::`) and the memory URN is everything before it — which may
    // itself span more than two hierarchy levels (e.g. a per-user
    // `<org>::<agent>::app-user:<id>` memory), so a fixed two-segment prefix
    // would mis-split those (PR-475 review, Codex P2 — fixed here for parity
    // with resolveEdgeRef). Legacy single-`:` input is ambiguous and keeps
    // the historical two-segment memory heuristic. Memory rows may be stored
    // in either legacy (`:`) or canonical (`::`) form during the spec-021
    // migration window — the candidates match whichever form is on disk.
    const memLoc = isCanonical
      ? parts[parts.length - 1]
      : parts.slice(2).join(':');
    const memoryUrnCandidates = isCanonical
      ? [parts.slice(0, -1).join('::'), parts.slice(0, -1).join(':')]
      : [`${parts[0]}:${parts[1]}`, `${parts[0]}::${parts[1]}`];
    // Liveness in the query, not after it (PR #1080 review): a soft-deleted
    // holder of a re-used URN must not suppress the historical alias lookup.
    const memory = await db.memory.findFirst({
      where: {
        urn: { in: memoryUrnCandidates },
        ...(options?.includeDeleted ? {} : { deletedAt: null }),
      },
      select: { id: true, urn: true, deletedAt: true },
    });
    if (memory) {
      // A live node at the published address always wins. A live MEMORY row
      // with no node at this loc does not: its URN may have been reused after
      // the former memory was renamed, so the old node address can still be
      // reached through that memory's alias.
      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc: memLoc, memoryId: memory.id } },
        select: { id: true, deletedAt: true },
      });
      if (node && (options?.includeDeleted || !node.deletedAt)) return { id: node.id };
    }
    // #1079/#1391 — consult historical MEMORY holders even if another live
    // memory now owns the prefix. A prior memory rename followed by a node
    // move stored the NODE alias under that memory's CURRENT URN, while a
    // newly re-used old memory may have no node at the requested loc. The
    // old prefix itself conveys no authority; callers gate the resolved node.
    const historicalMemories = await findHistoricalMemories(
      db, memoryUrnCandidates, options?.includeDeleted,
    );
    const historicalIds = historicalMemories.map((m) => m.id).filter((id) => id !== memory?.id);
    const historicalNodes = historicalIds.length
      ? await db.node.findMany({
          where: {
            memoryId: { in: historicalIds }, loc: memLoc,
            ...(options?.includeDeleted ? {} : { deletedAt: null }),
          },
          select: { id: true },
        })
      : [];
    const moved = await findMovedNodes(db, [
      normalized,
      ...(memory ? [`${memory.urn}:${memLoc}`] : []),
      ...historicalMemories.map((m) => `${m.urn}:${memLoc}`),
    ], options?.includeDeleted);
    const candidates = new Map([...historicalNodes, ...moved].map((n) => [n.id, n]));
    if (candidates.size > 1) {
      throw new AmbiguousLegacyUrnError(ref, [...candidates.keys()]);
    }
    if (candidates.size === 1) return candidates.values().next().value!;
    if (strictUrnNode) {
      // Explicit `urn:node:` with no live memory at the named prefix
      // — reject without falling back to short-loc.
      throw new NodeNotFoundError(ref);
    }
  } else if (strictUrnNode) {
    // Explicit `urn:node:` with fewer than 3 segments is malformed.
    throw new NodeNotFoundError(ref);
  }

  // Form 4: short loc — resolve within the context memory. Reached
  // only for unprefixed inputs whose 2-segment prefix doesn't name a
  // live memory.
  //
  // API-boundary callers don't pass `contextMemoryId` (spec 022 FR-007a);
  // when it's absent here, the input was already qualified (the spec-022
  // gate above ran) but the prefix-memory lookup failed — surface as
  // NodeNotFoundError rather than dispatching to short-loc with no
  // context (which would fall through to a Prisma type error).
  if (contextMemoryId === undefined) {
    throw new NodeNotFoundError(ref);
  }
  const node = await db.node.findUnique({
    where: { loc_memoryId: { loc: normalized, memoryId: contextMemoryId } },
    select: { id: true, deletedAt: true },
  });
  if (!node || (!options?.includeDeleted && node.deletedAt)) throw new NodeNotFoundError(ref);
  return { id: node.id };
}
