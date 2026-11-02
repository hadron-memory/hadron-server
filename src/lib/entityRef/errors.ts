/**
 * Not-found errors for the entity-reference helpers (spec 007).
 *
 * Each error carries the input string the caller passed (which may
 * be an ID, a bare URN, or a prefixed URN — see resolveXxxRef) and, since
 * #1174, its stable wire CODE: they all extend {@link EntityNotFoundError},
 * which `formatError` maps once so the code reaches `extensions.code` instead
 * of being recoverable only by parsing the message. Adding a not-found here
 * needs nothing in formatError — that is the point of mapping the base class.
 *
 * MemoryNotFoundError lives in `src/lib/asset/gate.ts` from spec 006
 * and is re-exported from here for callers that import from one
 * place.
 */

export { MemoryNotFoundError } from '../asset/gate.js';
export { EntityNotFoundError } from './entityNotFound.js';

import { EntityNotFoundError } from './entityNotFound.js';

export class AgentNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('AGENT_NOT_FOUND', ref);
    this.name = 'AgentNotFoundError';
  }
}

export class AppNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('APP_NOT_FOUND', ref);
    this.name = 'AppNotFoundError';
  }
}

export class OrganizationNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('ORGANIZATION_NOT_FOUND', ref);
    this.name = 'OrganizationNotFoundError';
  }
}

/** Spec 049 Phase 2 — a scope ref (id) that resolves to no live Scope. */
export class ScopeNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('SCOPE_NOT_FOUND', ref);
    this.name = 'ScopeNotFoundError';
  }
}

export class UserNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('USER_NOT_FOUND', ref);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Thrown when an email ref matches MORE THAN ONE live account case-insensitively
 * (#774 review). `User.email` is only case-sensitively unique and `createAppUser`
 * stores the caller's email verbatim, so `Alice@x.com` and `alice@x.com` can
 * coexist. Rather than resolve to an arbitrary account (a wrong-grantee hazard on
 * a share), the resolver rejects the ambiguous ref — the caller can disambiguate
 * with the exact-case email, the handle, or the id.
 */
export class AmbiguousUserRefError extends Error {
  constructor(public ref: string) {
    super(`AMBIGUOUS_USER_REF: ${ref}`);
    this.name = 'AmbiguousUserRefError';
  }
}

/**
 * Surfaced by the entity-ref resolvers (#697) when a legacy URN input matches
 * MORE THAN ONE live row through the stored alias map (`legacyUrn`). The map is
 * non-unique, so an ambiguous legacy reference must fail LOUDLY with a typed
 * error rather than silently resolve to an arbitrary row — a wrong resolve is
 * worse than a not-found (the #697 acceptance criterion). GraphQL maps it to
 * `extensions.code: 'AmbiguousLegacyUrnError'`.
 */
export class AmbiguousLegacyUrnError extends Error {
  constructor(public ref: string, public candidateNodeIds?: readonly string[]) {
    super(`AMBIGUOUS_LEGACY_URN: ${ref}`);
    this.name = 'AmbiguousLegacyUrnError';
  }
}

/**
 * Surfaced by `resolveSecretRef` when the inbound reference (cuid id or an
 * `hrn:secret:<owner>::[…::]<name>` URN, #679) does not name a secret — or
 * when a secret URN is structurally malformed (bad owner marker, wrong
 * segment count).
 */
export class SecretNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('SECRET_NOT_FOUND', ref);
    this.name = 'SecretNotFoundError';
  }
}

/**
 * Surfaced by `resolveAppRunRef` when the inbound reference (an AppRun ID or an
 * `hrn:apprun:<root>:<app>:<run-id>` URN, #696) does not name a run — or when
 * the URN is structurally malformed / its app doesn't resolve.
 */
export class AppRunNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('APP_RUN_NOT_FOUND', ref);
    this.name = 'AppRunNotFoundError';
  }
}

/**
 * Surfaced by `resolveWorkerRef` when the inbound reference (a Worker ID or an
 * `hrn:worker:<root>:<app-slug>:<worker-slug>` URN, #991) does not name a
 * worker — or when the URN is structurally malformed / its App doesn't resolve.
 */
export class WorkerNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('WORKER_NOT_FOUND', ref);
    this.name = 'WorkerNotFoundError';
  }
}

/**
 * Surfaced by `resolveNodeRevRef` when the inbound reference (a NodeRevision ID
 * or an end-anchored `hrn:noderev:<root>:<mem>:<loc...>:<rev>` URN, #696) does
 * not name a revision — or when the URN is malformed / its node doesn't resolve.
 */
export class NodeRevisionNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('NODE_REVISION_NOT_FOUND', ref);
    this.name = 'NodeRevisionNotFoundError';
  }
}

/**
 * Surfaced by `resolveNodeRef` when the inbound reference (ID, URN,
 * full memory-prefixed loc, or short loc) does not name a live node.
 * Used by `upsertNode` to fail edge-target resolution loudly instead
 * of silently writing to `pending_edges` (issue #105).
 */
export class NodeNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('NODE_NOT_FOUND', ref);
    this.name = 'NodeNotFoundError';
  }
}

/**
 * Surfaced by `resolveEdgeRef` when the inbound reference (ID or
 * fully-qualified `hrn:edge:<memory-urn>::<loc>` URN) does not name a
 * live edge. Spec 037: edges are first-class, loc-addressed peers of
 * nodes, so they get the same typed not-found the other kinds have.
 */
export class EdgeNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('EDGE_NOT_FOUND', ref);
    this.name = 'EdgeNotFoundError';
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
 * Call sites that COMPUTE the new abstract from an existing one (`replaceText`,
 * `nodeMerge`) pass `edit.currentLength`, and the message then reports the
 * numbers a surgical edit needs — original length, delta, and headroom under
 * the cap (#1117). Create/full-replacement sites pass nothing (there is no
 * truthful "current" at validation time) and keep the bare message.
 *
 * GraphQL `extensions.code: 'NodeAbstractTooLongError'` per constitution
 * S2 (typed-error boundary).
 */
export class NodeAbstractTooLongError extends Error {
  public readonly max = 2000;
  /** Length of the abstract this edit started from, when the throw site knows it. */
  public readonly currentLength: number | null;
  constructor(
    public readonly length: number,
    edit?: { currentLength: number },
  ) {
    const sentences = [`Abstract exceeds 2000-character cap (got ${length} chars).`];
    if (edit != null) {
      const delta = length - edit.currentLength;
      const available = 2000 - edit.currentLength;
      sentences.push(
        `This edit takes a ${edit.currentLength}-character abstract to ${length} ` +
          `(${delta >= 0 ? '+' : ''}${delta}); ${available} characters were available.`,
      );
    }
    sentences.push(`Use a shorter summary or expand 'content' for the long form.`);
    super(sentences.join(' '));
    this.name = 'NodeAbstractTooLongError';
    this.currentLength = edit?.currentLength ?? null;
  }

  /**
   * Typed-error envelope for GraphQL adapters: the identity/length fields
   * every refusal carries, plus `currentLength`/`available` when the throw
   * site reported edit context — so every surface exposing this error
   * offers the same machine-actionable shape (Copilot round 1 on PR #1371).
   */
  extensionFields(): Record<string, unknown> {
    return {
      code: this.name,
      length: this.length,
      max: this.max,
      ...(this.currentLength != null
        ? { currentLength: this.currentLength, available: this.max - this.currentLength }
        : {}),
    };
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
 * GraphQL `extensions.code: 'ENCRYPTED_VECTOR_INDEX_NOT_ACKNOWLEDGED'`, delivered
 * by the class mapping in `api/graphql/formatError.ts` with `disclosure` and `memoryRef`.
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
