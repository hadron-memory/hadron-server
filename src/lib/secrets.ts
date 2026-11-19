import { GraphQLError } from 'graphql';
import { encryptToken, decryptToken } from './tokenCrypto.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { WebFetchAuth } from './webfetchClient.js';

/**
 * General secret store (#677) — shared grammar, per-kind validation, and
 * value crypto for the polymorphic `Secret` registry. One module so the
 * GraphQL write surface and the run-time resolver can never disagree about
 * what a secret name, owner scope, or kind payload means.
 *
 * Two ways a secret reaches its use, NOT interchangeable (the load-bearing
 * security model):
 *  - READ (`hadron_read_secret`): the decrypted value is returned to the
 *    agent/model — entitlement-gated; the exposure is the agent-author's
 *    accepted tradeoff.
 *  - INJECT (`web_poll_start`, future fetch-shaped tools): core resolves the
 *    name server-side and injects the value into the capability-tool call;
 *    the value never enters model context. Mandatory for tools that touch
 *    untrusted external content (exfiltration target otherwise).
 * Both share this store and the same cascade resolver.
 */

// Owners are user, org or APP. #696 (D-2026-07-15-006) narrowed them to org/user; #3997 (S2 of #3991,
// D-2026-11-12-001) made an App an owner again. The memory-owned shape stays superseded. An App row has NO value of its
// own (its value is its newest `secret_versions` row) and is NEVER in the run cascade below.
export const SECRET_OWNER_TYPES = ['user', 'org', 'app'] as const;
export type SecretOwnerType = (typeof SECRET_OWNER_TYPES)[number];

export function isSecretOwnerType(value: unknown): value is SecretOwnerType {
  return typeof value === 'string' && (SECRET_OWNER_TYPES as readonly string[]).includes(value);
}

/** CSS-cascade resolution order, most specific first (user overrides org). `app` is deliberately NOT in it (cor:sec:020:01). */
export const SECRET_SCOPE_ORDER: readonly SecretOwnerType[] = ['user', 'org'];

/** Cascade-resolution key: lowercase, dash-separated, unique per owner. */
export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * v1 kind registry — the per-kind validation hook is the extension seam.
 * `generic`: opaque JSON payload, free-form metadata (what
 * `hadron_read_secret` is for). `webfetch-auth`: typed payload
 * (bearer/basic/header), metadata `{ type, urlPrefix }`, origin-bound at
 * use — the inject-only webfetch polling credential.
 */
export const SECRET_KINDS = ['generic', 'webfetch-auth'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/**
 * Kinds whose plaintext MAY be returned to the model via `hadron_read_secret`
 * (the READ half of the read-vs-inject contract). Everything else is
 * INJECT-ONLY: server-side use only, value never in model context. This is
 * the enforcement half of the "load-bearing" model above — the read tool
 * consults it so the boundary can't be bypassed by asking for an inject-only
 * secret by name, and new kinds default to inject-only until deliberately
 * added here. `webfetch-auth` is inject-only: a poll fetches untrusted
 * external content, so a model holding that credential is an exfil target.
 */
export const MODEL_READABLE_SECRET_KINDS: readonly SecretKind[] = ['generic'];

/** True when `hadron_read_secret` is allowed to return this kind's value. */
export function isModelReadableKind(kind: string): boolean {
  return (MODEL_READABLE_SECRET_KINDS as readonly string[]).includes(kind);
}

/**
 * Q4 (cap): one named constant, in BYTES of the stored plaintext JSON (not characters: `'é'.repeat(16_400)` is 16,400
 * characters and 32,802 bytes). Another number from Holger is a change to this line.
 */
export const SECRET_VALUE_MAX_BYTES = 32 * 1024;
const MAX_METADATA_JSON_LENGTH = 4 * 1024;

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** Typed webfetch auth payload guard (moved from the #628 node scheme). */
export function isWebFetchAuth(value: unknown): value is WebFetchAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  switch (auth.type) {
    case 'bearer':
      return typeof auth.token === 'string' && auth.token.length > 0;
    case 'basic':
      return (
        typeof auth.username === 'string' &&
        typeof auth.password === 'string' &&
        auth.password.length > 0
      );
    case 'header':
      return (
        typeof auth.name === 'string' &&
        auth.name.length > 0 &&
        typeof auth.value === 'string' &&
        auth.value.length > 0
      );
    default:
      return false;
  }
}

/**
 * Validate a webfetch-auth urlPrefix SHAPE (create-time half of the binding;
 * `assertUrlWithinPrefix` is the use-time half). Credential scope is an
 * origin + pathname concept — userinfo/query/fragment in the prefix would be
 * a bearer hidden in the binding itself.
 */
export function assertValidUrlPrefix(rawPrefix: string): void {
  let prefix: URL;
  try {
    prefix = new URL(rawPrefix);
  } catch {
    throw badInput('metadata.urlPrefix must be an absolute URL.');
  }
  if (
    !['http:', 'https:'].includes(prefix.protocol) ||
    prefix.username ||
    prefix.password ||
    prefix.search ||
    prefix.hash
  ) {
    throw badInput(
      'metadata.urlPrefix must be an http(s) origin/path without userinfo, query, or fragment.',
    );
  }
}

export interface ValidatedSecretInput {
  metadata: Record<string, unknown>;
  valueEncrypted: string;
}

/** The validated half of a secret write, before any encryption: the owner chooses the key (platform or App). */
export interface ValidatedSecretPayload {
  metadata: Record<string, unknown>;
  /** The plaintext JSON that gets encrypted; `sizeBytes` is its byte length. */
  valueJson: string;
  sizeBytes: number;
}

/**
 * Per-kind validation hook + the ONLY write path for `valueEncrypted`.
 * Returns the normalized inspectable metadata and the ciphertext; there is
 * deliberately no read path back to the API surface (redaction by
 * construction). Unknown kinds fail loud — registering a new kind means
 * adding its branch here (the extensibility seam).
 */
export function validateAndEncryptSecret(
  kind: string,
  metadata: unknown,
  value: unknown,
  opts?: SecretPayloadOptions,
): ValidatedSecretInput {
  const { metadata: normalized, valueJson } = validateSecretPayload(kind, metadata, value, opts);
  return { metadata: normalized, valueEncrypted: encryptToken(valueJson) };
}

export interface SecretPayloadOptions {
  /**
   * Apply the value-size cap (default true). A metadata-only edit re-validates the STORED value for kind and shape
   * but passes false: the cap binds a value when it is written, so a value stored under an older, looser rule (an
   * org or user value of at most 32,768 characters but more than 32,768 bytes) never freezes its own metadata (#4157).
   */
  enforceValueSize?: boolean;
}

/** Per-kind validation, shared by every owner type; encryption is the caller's (platform key, or the App key). */
export function validateSecretPayload(
  kind: string,
  metadata: unknown,
  value: unknown,
  opts: SecretPayloadOptions = {},
): ValidatedSecretPayload {
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) {
    throw badInput(`Unknown secret kind "${kind}". v1 kinds: ${SECRET_KINDS.join(', ')}.`);
  }
  if (value === undefined || value === null) {
    throw badInput('value is required.');
  }
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw badInput('metadata must be a JSON object.');
  }
  const given = (metadata ?? {}) as Record<string, unknown>;

  let normalized: Record<string, unknown> = given;
  if (kind === 'webfetch-auth') {
    if (!isWebFetchAuth(value)) {
      throw badInput(
        'A webfetch-auth value must be {type:"bearer",token} | {type:"basic",username,password} | {type:"header",name,value}.',
      );
    }
    if (typeof given.urlPrefix !== 'string') {
      throw badInput('A webfetch-auth secret requires metadata.urlPrefix (its origin binding).');
    }
    assertValidUrlPrefix(given.urlPrefix);
    if (given.type !== undefined && given.type !== value.type) {
      throw badInput('metadata.type must match the value type (or be omitted — it is derived).');
    }
    // The inspectable half always carries the auth type, derived from the
    // payload so the two can never disagree.
    normalized = { ...given, type: value.type };
  }

  const metadataJson = JSON.stringify(normalized);
  if (metadataJson.length > MAX_METADATA_JSON_LENGTH) {
    throw badInput(`metadata is too large (max ${MAX_METADATA_JSON_LENGTH} JSON chars).`);
  }
  const valueJson = JSON.stringify(value);
  const sizeBytes = Buffer.byteLength(valueJson, 'utf8');
  if (opts.enforceValueSize !== false && sizeBytes > SECRET_VALUE_MAX_BYTES) {
    throw badInput(`value is too large (max ${SECRET_VALUE_MAX_BYTES} bytes).`);
  }
  return { metadata: normalized, valueJson, sizeBytes };
}

/** Decrypt a row's payload for RESOLUTION (run tool / server-side inject). */
export function decryptSecretValue(row: { valueEncrypted: string | null }): unknown {
  // An App row has no value of its own (its value is its newest version); this path is org/user only.
  if (row.valueEncrypted === null) throw new Error('A secret without a value of its own is not resolved here.');
  return JSON.parse(decryptToken(row.valueEncrypted));
}

/**
 * Hard-delete every secret owned by one entity — the owner-deletion cleanup
 * the polymorphic (FK-less) owner design requires by hand (#677 follow-up).
 * Call it from an owner's delete handler, inside that handler's transaction,
 * so the "no live secret survives its owner" invariant holds atomically:
 * secret resolution (cascade + GraphQL) does NOT re-check the owner's
 * deletedAt, so a soft-deleted org would otherwise keep live, resolvable
 * credentials. `db` accepts a Prisma tx client. Idempotent.
 */
export function deleteSecretsForOwner(
  db: Pick<PrismaClient, 'secret'>,
  ownerType: SecretOwnerType,
  ownerId: string,
): Promise<{ count: number }> {
  return db.secret.deleteMany({ where: { ownerType, ownerId } });
}
