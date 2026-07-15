/**
 * resolveSecretRef — convert an entity-reference string to a definite secret
 * ID (#683 / #679). A secret is addressable two ways:
 *   - a bare cuid id (the `Secret.id` column), or
 *   - an owner-scoped URN `hrn:secret:<owner-root>::[<app|memory>:<slug>::]<name>`.
 *
 * Unlike the other resolve*Ref helpers, a secret has NO `urn` column (it is
 * computed, not stored — cor:urn:010:01). So the URN path decomposes the URN
 * into its polymorphic owner + name, resolves the OWNER entity to an id via the
 * matching resolve*Ref, and looks the secret up by the `(ownerType, ownerId,
 * name)` unique. Owner disambiguation is by shape: `@<handle>` (or the
 * equivalent `user:<handle>`) → user, a bare domain → org, and an
 * `app:`/`memory:` marker segment → that app/memory (rooted at the org/user
 * before it).
 *
 * See `cor:urn:010:01` (grammar) and `cor:urn:010:02` (a secret URN must
 * disambiguate its owner or be cleanly rejected).
 *
 * v1 limitation (PR-684 Codex): the owner marker is exactly `<app|memory>:<slug>`,
 * so a secret owned by an app-SCOPED memory — whose `Memory.urn` is a
 * multi-segment path like `org::agent::app-user:<id>` — is NOT URN-addressable
 * and is reachable by its cuid id only. Extending the marker to carry a full
 * memory path is a cor:urn grammar change, deferred.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { assertFullyQualifiedUrn } from '../urn.js';
import {
  SecretNotFoundError,
  OrganizationNotFoundError,
  UserNotFoundError,
  AppNotFoundError,
} from './errors.js';
import { MemoryNotFoundError } from '../asset/gate.js';
import { resolveOrgRef } from './orgRef.js';
import { resolveUserRef } from './userRef.js';
import { resolveAppRef } from './appRef.js';
import { resolveMemoryRef } from './memoryRef.js';
import type { SecretOwnerType } from '../secrets.js';

export interface ParsedSecretUrn {
  ownerType: SecretOwnerType;
  /** A fully-qualified, resolvable reference to the OWNING entity. */
  ownerRef: string;
  /** The secret's name (the final hierarchy segment). */
  name: string;
}

/**
 * Decompose an `hrn:secret:…` URN into its owner (type + resolvable ref) and
 * name. Accepts the canonical `@<handle>` and the equivalent `user:<handle>`
 * user-root spellings, and both `hrn:`/legacy `urn:` prefixes and the bare
 * form. Throws `SecretNotFoundError` (used as the parse-error surface too, so
 * a malformed URN and an absent secret are indistinguishable — no existence
 * disclosure) on a structurally invalid secret URN.
 */
export function parseSecretUrn(ref: string): ParsedSecretUrn {
  // Strip the optional `hrn:secret:` / legacy `urn:secret:` prefix.
  const prefixMatch = ref.match(/^(?:hrn|urn):secret:(.+)$/i);
  const body = prefixMatch ? prefixMatch[1] : ref;
  // No whitespace trimming: a segment with surrounding space is malformed, not
  // silently canonicalized (parity with the other resolve*Ref helpers / parseUrn
  // — PR-684 Copilot).
  const segments = body.includes('::') ? body.split('::') : body.split(':');
  if (segments.length < 2 || segments.length > 3 || segments.some((s) => s.length === 0)) {
    throw new SecretNotFoundError(ref);
  }
  const root = segments[0];
  const name = segments[segments.length - 1];

  // Root → the org/user the secret (or its owning app/memory) is rooted at.
  // `@handle` and `user:handle` both mean the user; a bare token is an org.
  let rootType: 'org' | 'user';
  let rootHandleOrDomain: string;
  const userMarker = /^user:([A-Za-z0-9._-]+)$/.exec(root);
  if (root.startsWith('@')) {
    rootType = 'user';
    rootHandleOrDomain = root.slice(1);
  } else if (userMarker) {
    rootType = 'user';
    rootHandleOrDomain = userMarker[1];
  } else {
    rootType = 'org';
    rootHandleOrDomain = root;
  }
  if (rootHandleOrDomain.length === 0) throw new SecretNotFoundError(ref);

  if (segments.length === 2) {
    // Directly org-/user-owned secret: the root IS the owner.
    return rootType === 'user'
      ? { ownerType: 'user', ownerRef: `hrn:user:${rootHandleOrDomain}`, name }
      : { ownerType: 'org', ownerRef: rootHandleOrDomain, name };
  }

  // App-/memory-owned secret: the middle segment is `<app|memory>:<slug>`,
  // rooted at the org/user above. Compose the owning entity's URN for its
  // resolve*Ref (`hrn:app:<root>::<slug>` / `hrn:memory:<root>::<slug>`).
  const markerAtoms = segments[1].split(':');
  if (markerAtoms.length !== 2) throw new SecretNotFoundError(ref);
  const [markerType, slug] = markerAtoms;
  if ((markerType !== 'app' && markerType !== 'memory') || slug.length === 0) {
    throw new SecretNotFoundError(ref);
  }
  const rootUrnPart = rootType === 'user' ? `@${rootHandleOrDomain}` : rootHandleOrDomain;
  return {
    ownerType: markerType,
    ownerRef: `hrn:${markerType}:${rootUrnPart}::${slug}`,
    name,
  };
}

/** Resolve the owning entity's id for a parsed secret URN. */
async function resolveSecretOwnerId(db: PrismaClient, parsed: ParsedSecretUrn): Promise<string> {
  switch (parsed.ownerType) {
    case 'org':
      return (await resolveOrgRef(db, parsed.ownerRef)).id;
    case 'user':
      return (await resolveUserRef(db, parsed.ownerRef)).id;
    case 'app':
      return (await resolveAppRef(db, parsed.ownerRef)).id;
    case 'memory':
      return (await resolveMemoryRef(db, parsed.ownerRef)).id;
  }
}

export async function resolveSecretRef(
  db: PrismaClient,
  ref: string,
): Promise<{ id: string }> {
  if (isIdFunc(ref)) {
    const secret = await db.secret.findUnique({ where: { id: ref }, select: { id: true } });
    if (!secret) throw new SecretNotFoundError(ref);
    return { id: secret.id };
  }

  // Non-ID inputs MUST be fully-qualified URNs (spec 022).
  assertFullyQualifiedUrn(ref, 'secret');
  const parsed = parseSecretUrn(ref);

  let ownerId: string;
  try {
    ownerId = await resolveSecretOwnerId(db, parsed);
  } catch (err) {
    // A missing owner and a missing secret are indistinguishable — no existence
    // disclosure for a well-formed URN whose owner is absent. Only genuine
    // owner-not-found is masked; operational/DB errors propagate (PR-684 review).
    if (
      err instanceof OrganizationNotFoundError ||
      err instanceof UserNotFoundError ||
      err instanceof AppNotFoundError ||
      err instanceof MemoryNotFoundError
    ) {
      throw new SecretNotFoundError(ref);
    }
    throw err;
  }

  const secret = await db.secret.findUnique({
    where: {
      ownerType_ownerId_name: { ownerType: parsed.ownerType, ownerId, name: parsed.name },
    },
    select: { id: true },
  });
  if (!secret) throw new SecretNotFoundError(ref);
  return { id: secret.id };
}
