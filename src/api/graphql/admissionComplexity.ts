/**
 * GraphQL request admission, layer L4 (hadron-internal#3): the depth and estimated cost of the SELECTED operation,
 * judged before any resolver runs. Layers L1-L3 (size, tokens, expanded selections) are in `admission.ts`.
 *
 * It is an Apollo plugin on `didResolveOperation`: the operation is chosen, no resolver has run, and a thrown error
 * answers the request without executing anything. Two measures, in order:
 *
 *   1. depth  hand-written: field nesting of the selected operation. Inline fragments and spreads are transparent and a
 *             fragment's depth is memoized by name. A cycle or an unknown fragment fails closed (validation already
 *             prevents both).
 *   2. cost   `graphql-query-complexity` 2.0.0 over a document holding ONLY the selected operation and the fragments,
 *             with this module's estimator first and `simpleEstimator` (1 per field) behind it.
 *
 * ## The cost model, and what it does not bound
 *
 * A leaf costs 1. A field that returns a list costs `1 + size x children`. `size` is what the request states through a
 * page-size argument (`first`, `last`, `limit`, `top`, `take`, `pageSize`, `count`), after variables are coerced, so a
 * literal and a variable count the same. Most paged fields in this schema are not lists themselves but WRAPPERS around
 * a list (`Query.x(limit): XPage { items }`), so a wrapper that declares a page-size argument scales its children by
 * `size / listFactor` (never below 1): the list inside it is costed at the factor, and the wrapper corrects it.
 *
 * The state of the argument decides `size`, and every fallback is chosen so the model does not UNDERCOUNT work:
 *   - a non-negative or negative integer: `max(1, |value|)`. Zero is not free (a resolver may bump it to 1), and a
 *     negative `take` pages from the end, so its magnitude is the work;
 *   - omitted or null: the field's own default when it is known to exceed the common one (`OMITTED_PAGE_SIZE`),
 *     otherwise `DEFAULT_OMITTED_PAGE_SIZE`, the largest default in common use;
 *   - caps a resolver applies to a large request are NOT modelled, so a clamped field is over-counted, never under-counted.
 * A list with no page-size argument is costed at `listFactor`: this model cannot bound a list whose length the request
 * does not state. It also does not model per-resolver cost, database cost, response bytes, or work done by directives.
 * Nor does it bound: `findNodes(expand:)`, which appends graph neighbours after the page with no cap of its own; or
 * introspection (`__schema`/`__type` score 0 with their subtrees), which Apollo refuses under NODE_ENV=production
 * (a deployment that boots without it has no bound on introspection fan-out from this layer).
 *
 * Meta fields cost 0. Each list's score saturates at `maxCost + 1`, so nothing wraps around and nothing is free.
 *
 * ## Mode
 *
 * `enforce` refuses an over-limit operation with `QUERY_TOO_COMPLEX` (HTTP 400, fixed text, never an echo). `observe`
 * measures every request the same way and only logs what it WOULD refuse, then admits it; it is not an off switch.
 * An estimator failure refuses in `enforce` (fail closed) and is logged in both.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import {
  GraphQLError,
  Kind,
  assertSchema,
  getNullableType,
  getVariableValues,
  isListType,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { getComplexity, simpleEstimator, type ComplexityEstimator } from 'graphql-query-complexity';
import type { GraphqlAdmissionConfig } from './admission.js';

export const QUERY_TOO_COMPLEX = 'QUERY_TOO_COMPLEX';

/** The thrown refusal, so the error boundary can recognise it by type. */
export class QueryTooComplexError extends GraphQLError {
  constructor(public readonly limit: 'depth' | 'cost', public readonly max: number) {
    super('The GraphQL query is too complex.', {
      extensions: { code: QUERY_TOO_COMPLEX, limit, max, http: { status: 400 } },
    });
    this.name = 'QueryTooComplexError';
  }
}

const PAGE_ARG = /^(first|last|limit|top|take|pageSize|count)$/;
/** The largest default page size in common use across this schema's resolvers (100 for chat lists, 50 elsewhere). */
export const DEFAULT_OMITTED_PAGE_SIZE = 100;
/** Fields whose resolver default, when the argument is omitted, exceeds the common one (reviewed against the resolvers). */
export const OMITTED_PAGE_SIZE: Readonly<Record<string, number>> = {
  'Query.memoryNodes': 1000,
  'Query.memoryEdges': 1000,
  'Query.validateMemory': 200,
  'Query.appNodes': 500,
};
/** The library's fragment expansion is not memoized; this bounds it (L3 runs earlier at validation). */
export const MAX_QUERY_NODES = 10_000;
const NODE_CAP_MESSAGE = 'Query exceeds the maximum allowed number of nodes.';

/** The page size a request states for a field, per the rules in the module header. */
function pageSizeOf(
  fieldKey: string,
  declared: string | undefined,
  args: Record<string, unknown>,
): number | null {
  if (declared === undefined) return null;
  const v = args[declared];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return Math.max(1, Math.abs(v));
  return OMITTED_PAGE_SIZE[fieldKey] ?? DEFAULT_OMITTED_PAGE_SIZE;
}

/** The first estimator: returns undefined for a field it has no opinion on, so `simpleEstimator` scores it as 1. */
export function hadronListEstimator(limits: Pick<GraphqlAdmissionConfig, 'maxCost' | 'listFactor'>): ComplexityEstimator {
  const ceiling = limits.maxCost + 1;
  return ({ type, field, args, childComplexity }) => {
    if (field.name === '__schema' || field.name === '__type' || field.name === '__typename') return 0;
    const isList = isListType(getNullableType(field.type));
    const declared = field.args.find((a) => PAGE_ARG.test(a.name))?.name;
    if (!isList && declared === undefined) return undefined;
    const size = pageSizeOf(`${type.name}.${field.name}`, declared, args) ?? limits.listFactor;
    // A list multiplies its children by its size; a wrapper around a list corrects the factor its list child was
    // costed at (the list inside it carries no argument of its own).
    const factor = isList ? size : Math.max(1, size / limits.listFactor);
    const raw = 1 + factor * childComplexity;
    return Number.isFinite(raw) ? Math.min(raw, ceiling) : ceiling;
  };
}

function fragmentMap(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const out = new Map<string, FragmentDefinitionNode>();
  for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) out.set(d.name.value, d);
  return out;
}

/** Field nesting of an operation; `Infinity` when a fragment cycle or an unknown fragment is met (fails closed). */
export function selectedOperationDepth(
  operation: OperationDefinitionNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): number {
  const memo = new Map<string, number>();
  const active = new Set<string>();
  const set = (selectionSet: SelectionSetNode): number => {
    let max = 0;
    for (const s of selectionSet.selections) {
      if (s.kind === Kind.FIELD) {
        if (s.name.value === '__schema' || s.name.value === '__type') continue;
        max = Math.max(max, 1 + (s.selectionSet ? set(s.selectionSet) : 0));
      } else if (s.kind === Kind.INLINE_FRAGMENT) {
        max = Math.max(max, set(s.selectionSet));
      } else {
        const name = s.name.value;
        const known = memo.get(name);
        if (known !== undefined) { max = Math.max(max, known); continue; }
        const def = fragments.get(name);
        if (!def || active.has(name)) return Infinity;
        active.add(name);
        const d = set(def.selectionSet);
        active.delete(name);
        memo.set(name, d);
        max = Math.max(max, d);
      }
    }
    return max;
  };
  return set(operation.selectionSet);
}

type Outcome = 'would_refuse' | 'refused' | 'error' | 'near_limit';

interface Deps {
  /** One JSON line to stdout by default. */
  log?: (line: string) => void;
  now?: () => number;
  /** Test seam: replaces the estimator list (to prove the fail-closed branch). */
  estimators?: ComplexityEstimator[];
  /** Test seams for the log bounds (defaults below). */
  maxKeys?: number;
  decisionBudget?: number;
  marginBudget?: number;
}

const LOG_WINDOW_MS = 60_000;
const LOG_KEYS_MAX = 1000;
/** Lines per window for the outcomes that carry a decision (would_refuse, refused, error) ... */
const LOG_DECISION_BUDGET = 30;
/** ... and, separately, for near_limit, so a flood of margin readings cannot starve the decisions. */
const LOG_MARGIN_BUDGET = 10;
const NEAR_LIMIT_FRACTION = 0.5;
const OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,99}$/;

export function complexityAdmissionPlugin(
  config: Pick<GraphqlAdmissionConfig, 'maxDepth' | 'maxCost' | 'listFactor' | 'complexityMode'>,
  deps: Deps = {},
): ApolloServerPlugin<{ userId?: string; appId?: string; apiKeyId?: string }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const estimators = deps.estimators ?? [hadronListEstimator(config), simpleEstimator({ defaultComplexity: 1 })];

  // At most one line per (outcome, query hash) per window, and at most LOG_GLOBAL_BUDGET lines per window overall, so a
  // caller cannot flood the log by repeating a query or by varying it. Suppressed requests only increment bounded
  // counters; a count is reported on the next line that is permitted, never as an extra line.
  const perKey = new Map<string, { at: number; suppressed: number }>();
  const maxKeys = deps.maxKeys ?? LOG_KEYS_MAX;
  const budgets = { decision: deps.decisionBudget ?? LOG_DECISION_BUDGET, margin: deps.marginBudget ?? LOG_MARGIN_BUDGET };
  let windowStart = now();
  const emitted = { decision: 0, margin: 0 };
  const suppressedOther = { decision: 0, margin: 0 };

  function emit(outcome: Outcome, fields: Record<string, unknown>, queryHash: string | undefined): void {
    const t = now();
    if (t - windowStart >= LOG_WINDOW_MS) { windowStart = t; emitted.decision = 0; emitted.margin = 0; }
    const cls = outcome === 'near_limit' ? 'margin' : 'decision';
    const key = `${outcome}:${queryHash ?? ''}`;
    const entry = perKey.get(key);
    if (entry && t - entry.at < LOG_WINDOW_MS) { entry.suppressed = Math.min(entry.suppressed + 1, 1_000_000); return; }
    if (emitted[cls] >= budgets[cls]) { suppressedOther[cls] = Math.min(suppressedOther[cls] + 1, 1_000_000); return; }
    emitted[cls] += 1;
    const suppressed = entry?.suppressed ?? 0;
    perKey.delete(key);
    perKey.set(key, { at: t, suppressed: 0 });
    if (perKey.size > maxKeys) perKey.delete(perKey.keys().next().value as string);
    const extra: Record<string, number> = {};
    if (suppressed > 0) extra.suppressed = suppressed;
    if (suppressedOther[cls] > 0) { extra.suppressedOther = suppressedOther[cls]; suppressedOther[cls] = 0; }
    log(JSON.stringify({
      event: 'graphql.admission.l4', mode: config.complexityMode, outcome, ...fields, ...extra, at: new Date(t).toISOString(),
    }));
  }

  return {
    async requestDidStart() {
      return {
        async didResolveOperation(rc) {
          const operation = rc.operation as OperationDefinitionNode | undefined;
          if (!operation) return;
          const enforce = config.complexityMode === 'enforce';
          const fragments = fragmentMap(rc.document);

          let depth: number;
          try { depth = selectedOperationDepth(operation, fragments); } catch { depth = Infinity; }

          let cost: number | null = null;
          let failed = false;
          // A schema built by a second copy of graphql would make every type check below quietly answer "no" under
          // NODE_ENV=production (the library only throws in development). Say so loudly instead: it is an `error`.
          try { assertSchema(rc.schema); } catch { failed = true; }
          if (!failed && depth <= config.maxDepth) {
            const coerced = getVariableValues(rc.schema, operation.variableDefinitions ?? [], rc.request.variables ?? {});
            // A variable the schema rejects is refused by execution itself, before any resolver; skipping the estimate
            // cannot admit work, and the library would otherwise throw on it and turn an ordinary input error into this one.
            if (!coerced.errors) {
              const selected: DocumentNode = { kind: Kind.DOCUMENT, definitions: [operation, ...fragments.values()] };
              try {
                cost = getComplexity({
                  schema: rc.schema, query: selected, variables: rc.request.variables ?? {},
                  estimators, maxQueryNodes: MAX_QUERY_NODES,
                });
              } catch (e) {
                if (e instanceof GraphQLError && e.message === NODE_CAP_MESSAGE) cost = Infinity;
                else failed = true;
              }
            }
          }

          const name = rc.request.operationName ?? operation.name?.value ?? null;
          const ctx = rc.contextValue;
          const fields = {
            limit: undefined as 'depth' | 'cost' | undefined,
            measured: undefined as number | null | undefined,
            max: undefined as number | undefined,
            depth: Number.isFinite(depth) ? depth : null,
            cost: cost !== null && Number.isFinite(cost) ? cost : null,
            operationType: operation.operation,
            operationName: name && OPERATION_NAME.test(name) ? name : null,
            queryHash: rc.queryHash ?? null,
            principal: ctx?.userId ? 'user' : ctx?.appId || ctx?.apiKeyId ? 'app' : 'anonymous',
          };
          const record = (outcome: Outcome, over?: { limit: 'depth' | 'cost'; measured: number; max: number }) => {
            const { limit, measured, max, ...rest } = fields;
            void limit; void measured; void max;
            emit(outcome, over ? { limit: over.limit, measured: Number.isFinite(over.measured) ? over.measured : null, max: over.max, ...rest } : rest, rc.queryHash ?? undefined);
          };

          if (depth > config.maxDepth) {
            record(enforce ? 'refused' : 'would_refuse', { limit: 'depth', measured: depth, max: config.maxDepth });
            if (enforce) throw new QueryTooComplexError('depth', config.maxDepth);
            return;
          }
          if (failed) {
            record('error');
            if (enforce) throw new QueryTooComplexError('cost', config.maxCost);
            return;
          }
          if (cost !== null && cost > config.maxCost) {
            record(enforce ? 'refused' : 'would_refuse', { limit: 'cost', measured: cost, max: config.maxCost });
            if (enforce) throw new QueryTooComplexError('cost', config.maxCost);
            return;
          }
          if (depth >= config.maxDepth * NEAR_LIMIT_FRACTION || (cost !== null && cost >= config.maxCost * NEAR_LIMIT_FRACTION)) {
            record('near_limit');
          }
        },
      };
    },
  };
}
