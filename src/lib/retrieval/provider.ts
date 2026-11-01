/**
 * Node retrieval seam (D14 / cor:rag:010:02). Callers (the findNodes resolver,
 * the MCP find-nodes tool) depend on this interface, not on Postgres directly,
 * so the engine can be swapped for another database later. The interface is the
 * portability guarantee — NOT feature parity: the Postgres impl leans on native
 * FTS (ts_rank_cd) and pgvector, which another backend would reimplement,
 * possibly at lower fidelity.
 */
import type { ContentScope } from '../comments/scope.js';
import type { NodeApprovalState } from '../nodeApproval.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VectorHit, ChunkHit } from '../../services/embedding/vectors.js';
import type { NodeWhere, NodePropertySort } from './nodeWhere.js';

export type { VectorHit, ChunkHit };
export type { NodePropertySort };

/** Node fields carried in the weighted tsvector (lexical search). Ordered by weight class. */
export type LexicalField =
  | 'name' | 'alias'            // class A
  | 'loc' | 'tags'             // class B
  | 'description' | 'abstract' // class C
  | 'content' | 'properties' | 'data'; // class D

export interface LexicalHit {
  nodeId: string;
  score: number;
}

/** Ordering for a lexical query. `relevance` = by score; the rest suppress scoring. */
export type LexicalSort = 'relevance' | 'loc' | 'seq' | 'updatedAt';

/**
 * Structured node-attribute filters applied IN the lexical SQL (so filter +
 * sort + pagination are exact — no relevance-truncation-then-filter artifacts).
 */
export interface NodeSqlFilter {
  /** #2175: caller-scoped recovery audience. When set, other memories' tombstones never reach ranking/paging. */
  tombstoneMemoryIds?: string[];
  nodeType?: string | null;
  /** #3113 — an explicit, already validated list (`checkNodeTypesFilter`): `node_type = ANY(list)`. Never set together with `nodeType`. */
  nodeTypes?: string[] | null;
  /** #725 — collection discriminator facet (which domain object; e.g. "competitor"). */
  objectType?: string | null;
  isRunnable?: boolean | null;
  /** #1322 — exact role or a dotted descendant on a segment boundary. */
  role?: string | null;
  tags?: string[] | null;
  locPrefix?: string | null;
  createdBy?: string | null;
  updatedAfter?: string | null;
  updatedBefore?: string | null;
  /**
   * Structured predicate over the `properties` / `data` JSONB columns (#719),
   * compiled to parameterized SQL and AND-combined with the coarse filters
   * above. See {@link file://./nodeWhere.ts}.
   */
  where?: NodeWhere | null;
  /** #1591 — approval state; see `approvalStateSql`. */
  approvalState?: NodeApprovalState | null;
  /** #1591 — minted (true) or unminted (false) nodes only. */
  minted?: boolean | null;
  /**
   * #1608 — content, comments or both (cor:dmo:110:08). Callers pass the
   * EFFECTIVE scope ({@link effectiveContentScope}); absent means CONTENT.
   */
  contentScope?: ContentScope | null;
}

/** Ordering for the no-query browse (relevance is meaningless without a query). */
export type BrowseSort = 'loc' | 'seq' | 'updatedAt';

export interface FilterSearchOpts {
  db: PrismaClient;
  memoryIds: string[];
  filter?: NodeSqlFilter;
  includeDeleted?: boolean;
  /** Deterministic browse order (default loc). */
  sort?: BrowseSort;
  /** #719 — order by a `properties`/`data` JSON path; overrides `sort` when set. */
  propertySort?: NodePropertySort;
  offset?: number;
  limit: number;
}

/** Exact no-query match count; deliberately has no paging or sorting arguments. */
export interface FilterCountOpts {
  db: PrismaClient;
  memoryIds: string[];
  filter?: NodeSqlFilter;
  includeDeleted?: boolean;
  /** Effective-memory overrides/boot prompts already excluded by the read scope. */
  excludeNodeIds?: string[];
}

export interface FilterWhereOpts {
  /** #2175: same recovery subset as the ranked candidate selector. */
  tombstoneMemoryIds?: string[];
  db: PrismaClient;
  /** Candidate node ids (e.g. a ranked vector/hybrid set) to narrow. */
  ids: string[];
  /** Access-scoped memory ids — re-asserted so an out-of-scope id can never survive. */
  memoryIds: string[];
  where: NodeWhere;
  includeDeleted?: boolean;
}

export interface LexicalSearchOpts {
  db: PrismaClient;
  /** #2421: opt-in role-task candidate set and abstract-only matching; ordinary search unchanged. */
  candidateNodeIds?: string[];
  abstractOnly?: boolean;
  /** Boolean surface grammar (see tsquery.ts). */
  query: string;
  memoryIds: string[];
  /** Weight-mask: only these fields' weight classes contribute to the score. Omit = all. */
  fields?: LexicalField[];
  /** Structured filters, applied in-SQL. */
  filter?: NodeSqlFilter;
  /** Include soft-deleted nodes (default false). */
  includeDeleted?: boolean;
  /** Ordering (default relevance). */
  sort?: LexicalSort;
  /** #719 — order by a `properties`/`data` JSON path; overrides `sort` when set. */
  propertySort?: NodePropertySort;
  offset?: number;
  limit: number;
}

export interface RegexSearchOpts {
  db: PrismaClient;
  /** POSIX regex (case-insensitive `~*`). */
  pattern: string;
  memoryIds: string[];
  /** Score weight-mask (matching still spans all text fields; cor:api:090:03). */
  fields?: LexicalField[];
  filter?: NodeSqlFilter;
  includeDeleted?: boolean;
  sort?: LexicalSort;
  /** #719 — order by a `properties`/`data` JSON path; overrides `sort` when set. */
  propertySort?: NodePropertySort;
  offset?: number;
  limit: number;
}

export interface VectorSearchOpts {
  db: PrismaClient;
  /** #2421: filter before the vector window, not after its cap. */
  candidateNodeIds?: string[];
  abstractOnly?: boolean;
  queryEmbedding: number[];
  memoryIds: string[];
  limit: number;
  /**
   * #1345 — called once per search with whether the provider's RAW candidate
   * window was exhausted (the index has nothing deeper). A caller that widens a
   * filtered window stops on this, not on a short result, which dedup can
   * produce without exhaustion. A provider that never calls it is treated as
   * not exhausted.
   */
  onWindow?: (w: { exhausted: boolean }) => void;
  /**
   * #1608 — a COMMENTS-scoped search is answered EXACTLY over comment vectors
   * (no ANN window), so it finds every matching comment (cor:dmo:110:08).
   * CONTENT and ALL keep the index-backed search; the caller's node filter
   * drops comments from a CONTENT result.
   */
  contentScope?: ContentScope | null;
}

export interface NodeRetrievalProvider {
  lexicalSearch(opts: LexicalSearchOpts): Promise<LexicalHit[]>;
  regexSearch(opts: RegexSearchOpts): Promise<LexicalHit[]>;
  vectorSearch(opts: VectorSearchOpts): Promise<VectorHit[]>;
  vectorSearchChunks(opts: VectorSearchOpts): Promise<ChunkHit[]>;
  /**
   * No-query filtered browse (cor:api:090:02): the structured filter (incl. a
   * `where` predicate) applied + sorted + paged in SQL, returning ordered node
   * ids. The resolver's browse path uses this when a `where` is present (Prisma
   * can't express the JSONB predicate); the plain no-filter browse stays Prisma.
   */
  filterSearch(opts: FilterSearchOpts): Promise<string[]>;
  /** Object-store paging uses the same structured filters without LIMIT/OFFSET. */
  filterCount(opts: FilterCountOpts): Promise<number>;
  /**
   * Narrow a bounded candidate id set to those satisfying a JSONB `where`
   * predicate (and re-assert the memory scope). Used to compose `where` with
   * vector/hybrid ranking, where filtering is a post-step on the ranked set
   * (the vector query runs against node_embeddings, not the nodes' JSONB).
   */
  filterWhere(opts: FilterWhereOpts): Promise<string[]>;
}
