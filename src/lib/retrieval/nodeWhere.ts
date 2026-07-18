/**
 * Node property/data predicate compiler (#719 — structured/faceted query).
 *
 * Compiles a recursive JSON predicate tree (the `where` filter on findNodes)
 * into a single parameterized SQL boolean expression over a node's `properties`
 * or `data` JSONB column. It is the fine-grained companion to the coarse
 * structured filters in {@link file://./provider.ts} (`NodeSqlFilter`) and rides
 * the same parameter accumulator, so a `where` composes with `nodeType`/`tags`/…
 * as one AND-chain.
 *
 * Injection-safe by construction:
 *  - column is safelisted to `properties` | `data` (never caller text),
 *  - operators are whitelisted,
 *  - JSON path atoms are charset-validated and inlined as a quoted `text[]`
 *    (NOT a bound array — dodges driver array-param quirks; validation
 *    guarantees the atoms cannot contain a quote),
 *  - every caller *value* goes through `bind` as a real parameter.
 *
 * Cast semantics: a leaf compares the extracted text (`#>>`) by default; `as:
 * number | datetime` route the left side through the IMMUTABLE guard functions
 * `hadron_safe_numeric` / `hadron_safe_timestamptz` (defined in
 * prisma/post-push.sql), which return NULL on unparseable input — so a junk
 * value drops the row instead of erroring the whole query. Range operators on
 * `text` are lexicographic; pass a cast for numeric/temporal ranges.
 *
 * Hard caps: a rich query surface is a DoS surface (cf. #415/#437), so tree
 * depth, leaf count, and path length are bounded. A violation (or any malformed
 * node) throws {@link NodeWhereError}, which the resolver maps to
 * `BAD_USER_INPUT` rather than a 500.
 */

/** The JSONB column a leaf reads. Safelisted — never interpolated from caller text. */
export type PredicateColumn = 'properties' | 'data';

/** How a leaf's extracted value is typed before comparison. */
export type PredicateCast = 'text' | 'number' | 'datetime' | 'boolean';

/**
 * One node in the `where` predicate tree. A node is EITHER a branch (exactly one
 * of `and` / `or` / `not`) OR a leaf (a `path` plus exactly one operator).
 */
export interface NodeWhere {
  // ── branch (exactly one) ──
  and?: NodeWhere[];
  or?: NodeWhere[];
  not?: NodeWhere;
  // ── leaf ──
  /** JSONB column; defaults to the compiler's `defaultColumn` (usually `properties`). */
  field?: PredicateColumn;
  /** Path of object keys into the column, e.g. ['capturedAt'] or ['a','b']. */
  path?: string[];
  /** Value typing for the comparison; default `text`. */
  as?: PredicateCast;
  // operators — a leaf carries exactly one
  eq?: unknown;
  ne?: unknown;
  in?: unknown[];
  lt?: unknown;
  lte?: unknown;
  gt?: unknown;
  gte?: unknown;
  between?: unknown[];
  exists?: boolean;
  /** jsonb containment (`@>`) of the JSON value at the path. */
  contains?: unknown;
}

/** Thrown on any malformed / oversized predicate; resolver maps to BAD_USER_INPUT. */
export class NodeWhereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeWhereError';
  }
}

/** Max nesting depth of the predicate tree (root = depth 1). */
export const WHERE_MAX_DEPTH = 4;
/** Max number of leaf predicates across the whole tree. */
export const WHERE_MAX_LEAVES = 32;
/** Max number of path segments in a single leaf. */
export const WHERE_MAX_PATH = 8;
/** Max items in an `in` list. */
export const WHERE_MAX_IN = 100;

/** Path segments must be identifier-like so they can be inlined as quoted literals safely. */
const ATOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BRANCH_KEYS = ['and', 'or', 'not'] as const;
const LEAF_OPS = ['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte', 'between', 'exists', 'contains'] as const;

/**
 * Compile a predicate tree to a parenthesized SQL boolean expression.
 *
 * @param root  the predicate tree.
 * @param bind  the shared parameter accumulator (`(v) => '$n'`), so values are
 *              never interpolated and params compose with the outer query.
 * @param opts.defaultColumn  column used when a leaf omits `field` (default `properties`).
 * @throws NodeWhereError on any malformed or oversized predicate.
 */
export function compileNodeWhere(
  root: NodeWhere,
  bind: (v: unknown) => string,
  opts: { defaultColumn?: PredicateColumn } = {},
): string {
  const defaultColumn = opts.defaultColumn ?? 'properties';
  let leaves = 0;

  function walk(node: NodeWhere, depth: number): string {
    if (depth > WHERE_MAX_DEPTH) {
      throw new NodeWhereError(`where nesting exceeds max depth ${WHERE_MAX_DEPTH}`);
    }
    if (node == null || typeof node !== 'object' || Array.isArray(node)) {
      throw new NodeWhereError('each where node must be an object');
    }

    const branches = BRANCH_KEYS.filter((k) => node[k] !== undefined);
    const ops = LEAF_OPS.filter((k) => node[k] !== undefined);

    if (branches.length > 0) {
      if (branches.length > 1) {
        throw new NodeWhereError(`a where node has at most one of and/or/not (got: ${branches.join(', ')})`);
      }
      if (ops.length > 0 || node.path !== undefined) {
        throw new NodeWhereError('a branch node (and/or/not) cannot also be a leaf');
      }
      const key = branches[0];
      if (key === 'not') {
        return `(NOT ${walk(node.not as NodeWhere, depth + 1)})`;
      }
      const children = node[key];
      if (!Array.isArray(children) || children.length === 0) {
        throw new NodeWhereError(`${key} must be a non-empty array`);
      }
      const joiner = key === 'and' ? ' AND ' : ' OR ';
      return `(${children.map((c) => walk(c, depth + 1)).join(joiner)})`;
    }

    if (++leaves > WHERE_MAX_LEAVES) {
      throw new NodeWhereError(`where exceeds max ${WHERE_MAX_LEAVES} leaf predicates`);
    }
    if (ops.length !== 1) {
      throw new NodeWhereError(`a leaf must carry exactly one operator (got ${ops.length}: ${ops.join(', ') || 'none'})`);
    }
    return compileLeaf(node, ops[0], defaultColumn, bind);
  }

  return walk(root, 1);
}

/** Build the safe JSONB path accessor SQL for a leaf. */
function accessor(node: NodeWhere, defaultColumn: PredicateColumn): { col: PredicateColumn; pathSql: string } {
  const col = node.field ?? defaultColumn;
  if (col !== 'properties' && col !== 'data') {
    throw new NodeWhereError(`unknown field column: ${JSON.stringify(col)}`);
  }
  const path = node.path;
  if (!Array.isArray(path) || path.length === 0) {
    throw new NodeWhereError('a leaf requires a non-empty path');
  }
  if (path.length > WHERE_MAX_PATH) {
    throw new NodeWhereError(`path exceeds max ${WHERE_MAX_PATH} segments`);
  }
  for (const atom of path) {
    if (typeof atom !== 'string' || !ATOM_RE.test(atom)) {
      throw new NodeWhereError(`invalid path segment ${JSON.stringify(atom)} (allowed: [A-Za-z0-9_-], 1-64 chars)`);
    }
  }
  // Atoms are ATOM_RE-validated (no quote possible) → safe to inline as literals.
  const pathSql = `ARRAY[${path.map((a) => `'${a}'`).join(', ')}]::text[]`;
  return { col, pathSql };
}

/** Coerce a caller value to the SQL text used for a `text`-cast comparison. */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  throw new NodeWhereError(`expected a string/number/boolean value, got ${JSON.stringify(v)}`);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new NodeWhereError(`expected a numeric value, got ${JSON.stringify(v)}`);
}

function asDateString(v: unknown): string {
  // Reject unparseable input up front so a bad bound surfaces as BAD_USER_INPUT,
  // not a Postgres cast error (500). The RHS is ALSO wrapped in
  // hadron_safe_timestamptz below, so even a Date.parse/Postgres edge-case
  // disagreement can never raise at execution time.
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v))) return v;
  throw new NodeWhereError(`expected a parseable ISO-8601 datetime string, got ${JSON.stringify(v)}`);
}

/** Coerce a caller value to the text a boolean-cast comparison binds. Rejects non-booleans. */
function asBoolText(v: unknown): 'true' | 'false' {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === 'true' || v === 'false') return v;
  throw new NodeWhereError(`expected a boolean (or 'true'/'false' string), got ${JSON.stringify(v)}`);
}

/** Compile one leaf (already known to carry exactly `op`). */
function compileLeaf(
  node: NodeWhere,
  op: (typeof LEAF_OPS)[number],
  defaultColumn: PredicateColumn,
  bind: (v: unknown) => string,
): string {
  const { col, pathSql } = accessor(node, defaultColumn);
  const textExpr = `(${col} #>> ${pathSql})`; // text extraction
  const jsonExpr = `(${col} #> ${pathSql})`; // jsonb extraction
  const cast: PredicateCast = node.as ?? 'text';

  // Left-hand side, typed per `as`.
  const lhs =
    cast === 'number'
      ? `hadron_safe_numeric(${textExpr})`
      : cast === 'datetime'
        ? `hadron_safe_timestamptz(${textExpr})`
        : textExpr; // text + boolean both compare the extracted text

  // Right-hand side for a single value, typed per `as`.
  const rhs = (v: unknown): string => {
    switch (cast) {
      case 'number':
        return `${bind(asNumber(v))}::numeric`;
      case 'datetime':
        // Guard the bound value too (symmetric with the LHS) so no datetime
        // string can raise a cast error at execution: a clearly-bad bound is
        // rejected by asDateString, and any residual edge-case parses to NULL.
        return `hadron_safe_timestamptz(${bind(asDateString(v))})`;
      case 'boolean':
        // jsonb booleans render as 'true'/'false' via #>>; compare that text.
        // Reject non-booleans rather than coercing by JS truthiness.
        return bind(asBoolText(v));
      default:
        return bind(asText(v));
    }
  };

  switch (op) {
    case 'exists': {
      if (typeof node.exists !== 'boolean') throw new NodeWhereError('exists must be a boolean');
      return node.exists ? `${jsonExpr} IS NOT NULL` : `${jsonExpr} IS NULL`;
    }
    case 'eq':
      return `${lhs} = ${rhs(node.eq)}`;
    case 'ne':
      // IS DISTINCT FROM so a missing key (NULL) counts as "not equal" and is returned.
      return `${lhs} IS DISTINCT FROM ${rhs(node.ne)}`;
    case 'lt':
      return `${lhs} < ${rhs(node.lt)}`;
    case 'lte':
      return `${lhs} <= ${rhs(node.lte)}`;
    case 'gt':
      return `${lhs} > ${rhs(node.gt)}`;
    case 'gte':
      return `${lhs} >= ${rhs(node.gte)}`;
    case 'in': {
      const list = node.in;
      if (!Array.isArray(list) || list.length === 0) throw new NodeWhereError('in must be a non-empty array');
      if (list.length > WHERE_MAX_IN) throw new NodeWhereError(`in list exceeds max ${WHERE_MAX_IN} items`);
      return `${lhs} IN (${list.map((v) => rhs(v)).join(', ')})`;
    }
    case 'between': {
      const b = node.between;
      if (!Array.isArray(b) || b.length !== 2) throw new NodeWhereError('between must be a [lo, hi] array');
      return `${lhs} BETWEEN ${rhs(b[0])} AND ${rhs(b[1])}`;
    }
    case 'contains': {
      // jsonb containment of the JSON value at the path (GIN-accelerable at col root).
      // Guard the serialize: a non-serializable value (e.g. BigInt) throws in
      // JSON.stringify, and stringify(undefined) yields JS undefined — both must
      // surface as BAD_USER_INPUT, not a 500 / silent NULL comparison.
      let json: string | undefined;
      try {
        json = JSON.stringify(node.contains);
      } catch {
        throw new NodeWhereError('contains value must be JSON-serializable');
      }
      if (json === undefined) throw new NodeWhereError('contains value must not be undefined');
      return `${jsonExpr} @> ${bind(json)}::jsonb`;
    }
    default:
      throw new NodeWhereError(`unknown operator: ${op}`);
  }
}
