/**
 * #2676 (P9) — the operator principal of the one-time boot-prompt conversion.
 *
 * The conversion runs from a host shell, with database access and no user, so none of the manager gates a request
 * meets can name it. This is the ONE seam that lets the compile, the node writer and the pointer write accept it.
 *
 * It is not a credential and cannot be presented: it exists only as an in-memory Context made by
 * {@link createOperatorConversionContext}, which only `src/admin` imports (pinned by a test that scans the tree).
 * The marker is a module-private symbol property, so no request-built Context, GraphQL variable, MCP argument or
 * JSON payload can carry it, and a spread copy of the Context (`{ ...ctx }`, which the writers make) keeps it.
 *
 * What it waives: the manager gate on the boot-prompt pointer and the compile, memory write access, and the
 * caller-readability filter the compile hands the assembler. What it never waives: every row check after those
 * (retired target, occupied address, compiled-node shape, tenant drift, include resolution and grants).
 * Revisions and approvals it makes carry the info string below, never a user id.
 */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

const OPERATOR = Symbol('operatorConversion');

/** Recorded as the editor / approver info on everything the conversion writes. */
export const OPERATOR_CONVERSION_INFO = 'operator:boot-prompt-conversion:P9';

type Db = Context['db'];

export function createOperatorConversionContext(db: Db): Context {
  return { db, userId: null, roles: [], clientId: OPERATOR_CONVERSION_INFO, [OPERATOR]: true } as unknown as Context;
}

export function isOperatorConversionContext(ctx: unknown): boolean {
  return typeof ctx === 'object' && ctx !== null && (ctx as Record<symbol, unknown>)[OPERATOR] === true;
}

/** Context copies that rebuild from `Object.entries` (which drops symbol keys) call this so the marker survives them. */
export function carryOperatorMark<T extends object>(from: unknown, to: T): T {
  if (isOperatorConversionContext(from)) (to as Record<symbol, unknown>)[OPERATOR] = true;
  return to;
}
