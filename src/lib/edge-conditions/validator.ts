/**
 * Save-time and evaluate-time structural validation for edge conditions.
 * A single AST walk checks: JSONLogic shape, operator allowlist, var-path
 * scope, reserved names, AST size, and nesting depth.
 */

import type { EvaluationError } from './errors.js';
import {
  V1_OPERATORS_SET,
  VALID_SCOPE_PREFIXES,
  VALID_BUILTINS,
  RESERVED_VAR_PATHS,
} from './operators.js';

const MAX_AST_SIZE_BYTES = 8192;
const MAX_AST_DEPTH = 10;

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: EvaluationError };

/**
 * Validates a JSONLogic edge condition. Null/undefined is valid (means
 * the edge fires unconditionally).
 */
export function validateEdgeCondition(condition: unknown): ValidateResult {
  if (condition === null || condition === undefined) {
    return { ok: true };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(condition);
  } catch {
    return failure('INVALID_JSON', 'condition is not JSON-serializable', {});
  }
  if (serialized === undefined) {
    // JSON.stringify can return undefined for top-level functions/symbols.
    return failure('INVALID_JSON', 'condition serializes to undefined', {});
  }
  if (serialized.length > MAX_AST_SIZE_BYTES) {
    return failure(
      'AST_TOO_LARGE',
      `condition serialized size ${serialized.length} exceeds limit ${MAX_AST_SIZE_BYTES}`,
      {},
    );
  }

  return walkAst(condition, 0);
}

function walkAst(node: unknown, depth: number): ValidateResult {
  if (depth > MAX_AST_DEPTH) {
    return failure(
      'AST_TOO_DEEP',
      `condition nesting depth exceeds limit ${MAX_AST_DEPTH}`,
      {},
    );
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const r = walkAst(child, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  if (node === null || typeof node !== 'object') {
    return { ok: true };
  }

  const keys = Object.keys(node);
  if (keys.length === 0) {
    return { ok: true };
  }
  if (keys.length > 1) {
    return failure(
      'INVALID_JSONLOGIC',
      `JSONLogic operator nodes must have exactly one key; found ${keys.length}: ${keys.join(', ')}`,
      {},
    );
  }

  const operator = keys[0];
  if (!V1_OPERATORS_SET.has(operator)) {
    return failure(
      'DISALLOWED_OPERATOR',
      `operator '${operator}' is not in the v1 allowlist`,
      { operator },
    );
  }

  const args = (node as Record<string, unknown>)[operator];

  // var: validate the path against scope and reserved-name rules.
  if (operator === 'var') {
    const r = checkVarReference(args);
    if (!r.ok) return r;
  }
  // missing / missing_some: validate each field path.
  if (operator === 'missing' || operator === 'missing_some') {
    const paths = extractFieldPaths(operator, args);
    for (const p of paths) {
      const r = checkVarPath(p);
      if (!r.ok) return r;
    }
  }

  return walkAst(args, depth + 1);
}

function checkVarReference(args: unknown): ValidateResult {
  // var args can be: a string path, an array [path, default], or null/empty
  // (= the entire data bag). Anything else is structurally invalid.
  if (args === null || args === undefined) return { ok: true };
  if (Array.isArray(args) && args.length === 0) return { ok: true };

  let path: unknown;
  if (typeof args === 'string') {
    path = args;
  } else if (Array.isArray(args)) {
    path = args[0];
  } else if (typeof args === 'object') {
    // Nested expression — recursion in walkAst handles its operators
    // and var refs. Nothing scope-checkable here at this level.
    return { ok: true };
  } else {
    return { ok: true };
  }

  if (typeof path !== 'string') {
    // Computed path (an expression) — defer to recursion.
    return { ok: true };
  }
  return checkVarPath(path);
}

function checkVarPath(path: string): ValidateResult {
  if (VALID_BUILTINS.includes(path)) return { ok: true };

  const hasScope = VALID_SCOPE_PREFIXES.some((p) => path.startsWith(p));
  if (!hasScope) {
    return failure(
      'UNKNOWN_SCOPE',
      `'${path}' does not begin with a valid scope (memory./chat./agent./message.data.) or builtin (now()/today())`,
      { field: path },
    );
  }

  for (const reserved of RESERVED_VAR_PATHS) {
    if (
      path === reserved ||
      path.startsWith(reserved + '.') ||
      path.startsWith(reserved + '[')
    ) {
      return failure(
        'RESERVED_NAME',
        `'${path}' references reserved name '${reserved}'`,
        { field: path },
      );
    }
  }

  return { ok: true };
}

function extractFieldPaths(op: 'missing' | 'missing_some', args: unknown): string[] {
  if (op === 'missing' && Array.isArray(args)) {
    return args.filter((x): x is string => typeof x === 'string');
  }
  if (op === 'missing_some' && Array.isArray(args) && args.length === 2) {
    const fields = args[1];
    if (Array.isArray(fields)) {
      return fields.filter((x): x is string => typeof x === 'string');
    }
  }
  return [];
}

function failure(
  code: EvaluationError['code'],
  message: string,
  detail: EvaluationError['detail'],
): ValidateResult {
  return { ok: false, error: { code, message, detail } };
}
