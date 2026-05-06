/**
 * Not-found errors for the entity-reference helpers (spec 007).
 *
 * Each error carries the input string the caller passed (which may
 * be an ID, a bare URN, or a prefixed URN — see resolveXxxRef). The
 * GraphQL error-code mapping happens at the resolver layer; this
 * module just exports the error classes.
 *
 * MemoryNotFoundError lives in `src/lib/asset/gate.ts` from spec 006
 * and is re-exported from here for callers that import from one
 * place.
 */

export { MemoryNotFoundError } from '../asset/gate.js';

export class AgentNotFoundError extends Error {
  constructor(public ref: string) {
    super(`AGENT_NOT_FOUND: ${ref}`);
    this.name = 'AgentNotFoundError';
  }
}

export class AppNotFoundError extends Error {
  constructor(public ref: string) {
    super(`APP_NOT_FOUND: ${ref}`);
    this.name = 'AppNotFoundError';
  }
}

export class OrganizationNotFoundError extends Error {
  constructor(public ref: string) {
    super(`ORGANIZATION_NOT_FOUND: ${ref}`);
    this.name = 'OrganizationNotFoundError';
  }
}

/**
 * Thrown by `upsertNode` when called with `createOnly: true` and a node
 * already exists at the target `(loc, memoryId)`. The GraphQL resolver
 * layer wraps it as `GraphQLError` with
 * `extensions.code: 'NodeLocConflictError'`.
 *
 * NOTE: `upsertNode` is upsert by default — passing `createOnly: false`
 * (or omitting the flag) preserves the legacy update-on-collision
 * behavior and never throws this error.
 */
export class NodeLocConflictError extends Error {
  constructor(public loc: string, public memoryId: string) {
    super(`A node already exists at loc "${loc}" in this memory.`);
    this.name = 'NodeLocConflictError';
  }
}

// Re-export from sibling modules so callers can import error classes
// from a single place.
export { InvalidLocError } from '../validateLoc.js';
