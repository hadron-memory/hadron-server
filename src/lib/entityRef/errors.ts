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
