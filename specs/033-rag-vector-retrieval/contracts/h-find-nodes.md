# Contract — `h-find-nodes` (extended) + GraphQL `nodes`

Extends the existing search surface (D5/FR-018). One surface, three modes; no new `h-search` tool.

## MCP `h-find-nodes` — input schema additions

Current params (`mcp/server.ts:957`): `query`, `parentRel?`, `memoryUrn?`, `brief?`, `limit?`. Add:

```ts
mode:        z.enum(['keyword', 'vector', 'hybrid']).optional()  // absent ⇒ 'keyword'
expand:      z.number().int().min(0).max(3).optional()           // default 0; graph neighbors
granularity: z.enum(['node', 'chunk']).optional()                // default 'node'
```

- `mode` absent ⇒ **byte-identical** to today's keyword search (FR-018, SC-007). The handler MUST NOT echo `mode` or vector-only fields into the keyword-path text when `mode` is absent.
- `granularity` only affects `vector`/`hybrid` on a `content-chunks`-bearing memory (FR-022). `node` (default) collapses chunk hits to one ranked node URN (best chunk wins). `chunk` returns passages.
- `expand` ≥ 1 appends undirected, all-edge-type neighbors within depth N **after** the ranked hits, unscored (FR-020).

## Behavior by mode

| mode | path |
|---|---|
| `keyword` | unchanged `matchesQuery` in-memory filter |
| `vector` | embed query (`search_query:` prefix) → raw-SQL cosine top-K in memory → join `nodes` (`deletedAt IS NULL` + access control) → rank |
| `hybrid` | run keyword + vector; fuse by RRF `score = Σ 1/(60 + rank)`; one ranked list |

## Result envelope (FR-021) — text tool surfaces flags as annotation lines

`h-find-nodes` returns plain text (`textResult()`). Diagnostic flags are dedicated lines:

- **`mode:vector` on a memory without a vector index** (`vectorIndexEnabled = false`):
  ```
  Note: this memory has no vector index — enable it on the memory to use mode:vector. [no_vector_index]
  Found 0 node(s):
  ```
  Empty hit list, explicit reason — never an error, never a silent keyword fallback.

- **`mode:hybrid` on a memory without a vector index** — keyword half still runs, degraded flag disclosed:
  ```
  Note: vector half unavailable (no vector index); showing keyword results only. [degraded:no_vector_index]
  Found N node(s):
  ...keyword hits...
  ```

- **Stale abstract-vector hit** (FR-023, abstract-only): the hit line carries the existing `Source: abstract-stale` marker (spec 032 shape). **Chunk hits never carry a staleness marker** (FR-023).

- **`granularity:'chunk'` passages**: each hit renders the parent URN + passage with locators, e.g.:
  ```
  - **<parent-urn>** — <name>  [chunk 3 @ chars 1480–1992]
    > …passage text…
  ```

## GraphQL `nodes` query (parity; `resolvers.ts:1706`)

Add the same `mode`/`expand`/`granularity` args. Because GraphQL returns structured data, the flags are **envelope fields**, not text lines. Introduce a wrapper result type so existing callers selecting `[Node!]` are unaffected only if they migrate; to preserve the current `[Node!]!` shape, expose flags via a sibling query or an optional extension type:

```graphql
type NodeSearchResult {
  nodes: [Node!]!
  reason: String        # 'no_vector_index' when mode:vector found no index
  degraded: String      # 'no_vector_index' when mode:hybrid ran keyword-only
}
"""Vector/hybrid-aware search. Keyword-only callers keep using `nodes`."""
nodeSearch(query: String!, memoryUrn: String, mode: SearchMode, expand: Int, granularity: SearchGranularity, limit: Int): NodeSearchResult!
enum SearchMode { keyword vector hybrid }
enum SearchGranularity { node chunk }
```

(Keeping the legacy `nodes` query untouched avoids breaking its `[Node!]!` contract; `nodeSearch` is the vector-aware entry. `/plan` may instead evolve `nodes` if no external caller depends on its exact return type — decided at `/tasks`.) typeDefs doc-comments updated in the same PR (constitution II); no raw backticks (S3).

## Access control (constitution V)

Vector/hybrid/expand MUST go through the same memory read-access gate as today's keyword search. The raw-SQL similarity query MUST be scoped `WHERE memory_id = $memory` for a memory the caller can read; cross-memory search is out of v1 (the query never spans memories).

## Typed errors (constitution S2/III)

The "no vector index" condition is **not** an error (it returns a flagged result). Invalid `expand`/`mode` values are rejected at the zod/GraphQL-enum boundary. No new typed error class is required on the read path.

## Tests (constitution I — integration, against `hadron_test` with pgvector)

- `mode` absent ⇒ identical to keyword (snapshot).
- vector retrieval ranks the semantically-closest node first incl. a zero-keyword-overlap query (SC-001).
- hybrid RRF places a both-signal node above a single-signal node (SC-007).
- `mode:vector`/`mode:hybrid` on unindexed memory emit the documented flags (SC-008).
- `granularity:'chunk'` returns correct char offsets + chunk index + parent URN (SC-005).
- `expand:1` appends neighbors unscored after ranked hits.
