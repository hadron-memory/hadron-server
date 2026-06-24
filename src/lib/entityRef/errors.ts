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

export class UserNotFoundError extends Error {
  constructor(public ref: string) {
    super(`USER_NOT_FOUND: ${ref}`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Surfaced by `resolveNodeRef` when the inbound reference (ID, URN,
 * full memory-prefixed loc, or short loc) does not name a live node.
 * Used by `upsertNode` to fail edge-target resolution loudly instead
 * of silently writing to `pending_edges` (issue #105).
 */
export class NodeNotFoundError extends Error {
  constructor(public ref: string) {
    super(`NODE_NOT_FOUND: ${ref}`);
    this.name = 'NodeNotFoundError';
  }
}

/**
 * Surfaced by `upsertNode` when called with `createOnly: true` and a
 * **live** (not soft-deleted) node already exists at the target
 * `(loc, memoryId)`. The GraphQL resolver layer reads `name` and
 * `message` off this class to construct a `GraphQLError` with
 * `extensions.code: 'NodeLocConflictError'` — i.e., this class is the
 * source of truth for the code string and the user-facing message; it
 * is not thrown raw to the wire.
 *
 * NOTE: `upsertNode` is upsert by default — passing `createOnly: false`
 * (or omitting the flag) preserves the legacy update-on-collision
 * behavior and never surfaces this error. Soft-deleted nodes at the
 * target loc are treated as not-existing for collision purposes; the
 * create resurrects them.
 */
export class NodeLocConflictError extends Error {
  constructor(public loc: string, public memoryId: string) {
    super(`A node already exists at loc "${loc}" in this memory.`);
    this.name = 'NodeLocConflictError';
  }
}

/**
 * Surfaced by `hadron_create_node`, `hadron_update_node`, `upsertNode` (GraphQL), and
 * the node.yaml importer when an `abstract` argument exceeds the spec-031
 * 2000-character cap. The cap is API-boundary validation (not a DB CHECK)
 * per data-model.md V1 / research D2 — "caps are validation, not
 * invariants." Carries the offending length so the user-facing message
 * can be actionable.
 *
 * GraphQL `extensions.code: 'NodeAbstractTooLongError'` per constitution
 * S2 (typed-error boundary).
 */
export class NodeAbstractTooLongError extends Error {
  public readonly max = 2000;
  constructor(public readonly length: number) {
    super(
      `Abstract exceeds 2000-character cap (got ${length} chars). ` +
        `Use a shorter summary or expand 'content' for the long form.`,
    );
    this.name = 'NodeAbstractTooLongError';
  }
}

/**
 * Surfaced by `hadron_get_node` when `contentScope` is outside the allowed
 * enum (`'content' | 'abstract' | 'all'`). Zod's `.enum()` produces the
 * validation error at the MCP boundary; this class exists for the
 * GraphQL surface and for any internal caller that re-validates.
 *
 * GraphQL `extensions.code: 'InvalidContentScopeError'` per constitution
 * S2.
 */
export class InvalidContentScopeError extends Error {
  public readonly allowed = ['content', 'abstract', 'all'] as const;
  constructor(public readonly value: string) {
    super(
      `Invalid contentScope: ${JSON.stringify(value)}. ` +
        `Allowed values: 'content' | 'abstract' | 'all'.`,
    );
    this.name = 'InvalidContentScopeError';
  }
}

/**
 * Spec 033 FR-026 — the four-point embedding-inversion disclosure that must
 * accompany an opt-in to vector indexing on an encrypted memory. Single
 * source of truth for the disclosure copy: the error message below quotes
 * it, the `updateMemory` typeDefs doc-comment quotes it, and the
 * EncryptedVectorIndexNotAcknowledgedError.disclosure property exposes it
 * for portal/disclosure-UI consumers. Update HERE to update everywhere.
 */
export const FR_026_DISCLOSURE = [
  '(a) Stored vectors are plaintext — they are NOT encrypted at rest the way the content column is.',
  '(b) Embedding inversion can partially reconstruct source text from a vector (partial, not full reconstruction).',
  '(c) Anyone with database access is therefore a potential viewer of that partial content, even though the content column itself is encrypted.',
  '(d) The opt-in is revocable; revoking stops further indexing AND removes the memory\'s already-stored vectors.',
] as const;

/**
 * 033-rag-vector-retrieval — surfaced by `updateMemory`/`createMemory` when a
 * caller tries to enable the vector index on an ENCRYPTED memory without
 * acknowledging the embedding-inversion disclosure (FR-026). Stored vectors
 * are plaintext and partially invertible, so an encrypted memory must not be
 * silently indexed; the caller affirms via `acknowledgeVectorInversionRisk`.
 * The CHECK constraint `chk_memory_vector_encrypted_ack` is the DB backstop.
 *
 * GraphQL `extensions.code: 'EncryptedVectorIndexNotAcknowledgedError'`.
 *
 * Carries the full four-point disclosure on `.disclosure` so a UI consumer
 * can render the same text the error message quotes.
 */
export class EncryptedVectorIndexNotAcknowledgedError extends Error {
  public readonly disclosure = FR_026_DISCLOSURE;
  constructor(public readonly memoryRef: string) {
    super(
      `ENCRYPTED_VECTOR_INDEX_NOT_ACKNOWLEDGED: enabling the vector index on ` +
        `the encrypted memory ${memoryRef} requires acknowledging the ` +
        `embedding-inversion disclosure. Pass ` +
        `acknowledgeVectorInversionRisk: true to proceed.\n\nDisclosure:\n` +
        FR_026_DISCLOSURE.map((line) => `  ${line}`).join('\n'),
    );
    this.name = 'EncryptedVectorIndexNotAcknowledgedError';
  }
}

/**
 * 033-rag-vector-retrieval — surfaced by `updateMemory`/`createMemory` when the
 * per-memory chunking dials are invalid (FR-003): `chunkTokens` must be > 0 and
 * `chunkOverlap` must be in `[0, chunkTokens)`. The CHECK constraints
 * `chk_memory_chunk_tokens_positive` / `chk_memory_chunk_overlap_valid` are the
 * DB backstop; this class is the friendly GraphQL-boundary error.
 *
 * GraphQL `extensions.code: 'InvalidChunkConfigError'`.
 */
export class InvalidChunkConfigError extends Error {
  constructor(public readonly reason: string) {
    super(`INVALID_CHUNK_CONFIG: ${reason}`);
    this.name = 'InvalidChunkConfigError';
  }
}

// Re-export from sibling modules so callers can import error classes
// from a single place.
export { InvalidLocError } from '../validateLoc.js';
export {
  UrnNotQualifiedError,
  type ExpectedUrnType,
} from '../urn.js';
