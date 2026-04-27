/**
 * V1 edge-condition operator and scope allowlists. The wrapper enforces
 * these on every save and every evaluation so the underlying JSONLogic
 * engine never sees a disallowed operator or unknown scope.
 *
 * See `spec-kits/specs/001-edge-condition-spec/data-model.md` for the
 * operator subset rationale.
 */

/**
 * The 16 operators allowed in v1. Any other JSONLogic operator (cat,
 * substr, min, max, map, reduce, filter, if, log, etc.) is rejected at
 * save time with a DISALLOWED_OPERATOR error.
 */
export const V1_OPERATORS: readonly string[] = [
  // Comparison
  '==', '!=', '<', '<=', '>', '>=',
  // Logical
  'and', 'or', '!',
  // Membership
  'in',
  // Variable / missing
  'var', 'missing', 'missing_some',
  // Arithmetic
  '+', '-', '*', '/',
] as const;

export const V1_OPERATORS_SET: ReadonlySet<string> = new Set(V1_OPERATORS);

/**
 * Valid scope prefixes for `var` references. Any path that doesn't begin
 * with one of these (and isn't a builtin) is rejected with UNKNOWN_SCOPE.
 */
export const VALID_SCOPE_PREFIXES: readonly string[] = [
  'memory.',
  'chat.',
  'agent.',
  'message.data.',
] as const;

/**
 * Time builtins. Referenced as `{"var": "now()"}` and `{"var": "today()"}`.
 * The evaluator pre-resolves these from the request's clock.
 */
export const VALID_BUILTINS: readonly string[] = ['now()', 'today()'] as const;

/**
 * Reserved variable paths. Conditions referencing these are rejected with
 * RESERVED_NAME at save time. The names are reserved for the future
 * agent-exceptions feature (separate spec).
 */
export const RESERVED_VAR_PATHS: readonly string[] = [
  'message.data.exception',
  'message.data.exceptions',
] as const;
