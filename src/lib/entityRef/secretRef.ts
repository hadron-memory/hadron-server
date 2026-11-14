/**
 * resolveSecretRef — convert an entity-reference string to a definite secret
 * ID (#683 / #679, narrowed by #696). A secret is addressable two ways:
 *   - a bare cuid id (the `Secret.id` column), or
 *   - an owner-scoped URN `hrn:secret:<root>:<name>` (org/user root), or
 *   - an App-owned URN `hrn:secret:<root>:app:<app-slug>:<name>` (#4154, cor:urn:010:01).
 *
 * The superseded #679 app-/memory-owned marker shape
 * (`hrn:secret:<root>::<app|memory>:<slug>::<name>`) stays REJECTED (#696, decision D-2026-07-15-006; masked as
 * not-found), as does a three-segment form without the literal `app`. The #702 audit found 0 such rows.
 *
 * The App arm resolves `<root>:<app-slug>` through `resolveAppRef`, so a renamed App's old slug keeps resolving
 * (stored alias map, cor:urn:010:02 / cor:urn:030:01). Every App-half failure (unknown, uninstalled, deleted,
 * ambiguous alias) answers the same `SecretNotFoundError` as a missing secret (cor:sec:020:02). This function is a
 * LOOKUP, never a gate: each surface gates what it returns after resolving (App members only). No run path calls it.
 *
 * Unlike the other resolve*Ref helpers, a secret has NO `urn` column (it is
 * computed, not stored — cor:urn:010:01). So the URN path decomposes the URN
 * into its owner root + name, resolves the OWNER principal to an id, and looks
 * the secret up by the `(ownerType, ownerId, name)` unique.
 *
 * Root → principal (Postel — accepts both grammars during the v2 transition):
 *   - the canonical v2 flat form uses a BARE root with no sigil
 *     (`hrn:secret:acme.com:stripe-key`, `hrn:secret:holger:stripe-key`); the
 *     unified per-server pool (#692) makes it unambiguous, so a bare root is
 *     resolved by trying the org namespace then the user namespace (the #702
 *     audit confirmed 0 handle↔org collisions).
 *   - the legacy `@<handle>` / `user:<handle>` root spellings still pin a user.
 *
 * See `cor:urn:010:01` (grammar) and `cor:urn:010:02` (a secret URN must
 * disambiguate its owner or be cleanly rejected).
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { assertFullyQualifiedUrn } from '../urn.js';
import {
  SecretNotFoundError,
  AppNotFoundError,
  AmbiguousLegacyUrnError,
  OrganizationNotFoundError,
  UserNotFoundError,
} from './errors.js';
import { resolveOrgRef } from './orgRef.js';
import { resolveAppRef } from './appRef.js';
import { resolveUserRef } from './userRef.js';
import { SECRET_NAME_RE, type SecretOwnerType } from '../secrets.js';

export interface ParsedSecretUrn {
  /**
   * 'user' when a legacy `@`/`user:` sigil pinned it; undefined for a bare v2
   * root (org-or-user, resolved by pool lookup).
   */
  rootType?: 'user';
  /** The bare root atom (org domain or user handle, sigil stripped; for an App secret, the App's root). */
  root: string;
  /** Set for an App-owned secret (`<root>:app:<app-slug>:<name>`); undefined for an org/user secret. */
  appSlug?: string;
  /** The secret's name (the final segment). */
  name: string;
}

/**
 * Decompose an `hrn:secret:…` URN into its owner root + name. Accepts the
 * canonical v2 flat form (`<root>:<name>`), the legacy `::`-separated form, and
 * the legacy `@<handle>` / `user:<handle>` user-root spellings. Both `hrn:`/
 * legacy `urn:` prefixes and the bare form are accepted. Throws
 * `SecretNotFoundError` (the parse-error surface too — a malformed URN and an
 * absent secret are indistinguishable, no existence disclosure) on a
 * structurally invalid secret URN, including the superseded 3-segment
 * app/memory-owned shape.
 */
export function parseSecretUrn(ref: string): ParsedSecretUrn {
  // Strip the optional `hrn:secret:` / legacy `urn:secret:` prefix.
  const prefixMatch = ref.match(/^(?:hrn|urn):secret:(.+)$/i);
  const body = prefixMatch ? prefixMatch[1] : ref;
  // No whitespace trimming: a segment with surrounding space is malformed, not
  // silently canonicalized (parity with the other resolve*Ref helpers).
  const hasLegacySeparator = body.includes('::');
  const segments = hasLegacySeparator ? body.split('::') : body.split(':');
  // App-owned (#4154): exactly `<root>:app:<app-slug>:<name>` in the flat v2 spelling. The legacy `::` spelling
  // (`<root>::app:<slug>::<name>`) and every other 3+-segment form stay rejected (#696).
  if (!hasLegacySeparator && segments.length === 4 && segments[1] === 'app') {
    const [appRoot, , appSlug, appName] = segments as [string, string, string, string];
    if (
      appRoot.length === 0 || /^@|^user:/.test(appRoot) || /\s/.test(appRoot) ||
      appSlug.length === 0 || /\s/.test(appSlug) || !SECRET_NAME_RE.test(appName)
    ) {
      throw new SecretNotFoundError(ref);
    }
    return { root: appRoot, appSlug, name: appName };
  }
  // Org/user-owned: exactly `<root>:<name>`.
  if (segments.length !== 2 || segments.some((s) => s.length === 0)) {
    throw new SecretNotFoundError(ref);
  }
  const rawRoot = segments[0];
  const name = segments[1];

  // `@handle` and `user:handle` both pin the user; a bare token is resolved by
  // pool lookup (org-or-user).
  const userMarker = /^user:([A-Za-z0-9._-]+)$/.exec(rawRoot);
  if (rawRoot.startsWith('@')) {
    const handle = rawRoot.slice(1);
    if (handle.length === 0) throw new SecretNotFoundError(ref);
    return { rootType: 'user', root: handle, name };
  }
  if (userMarker) {
    return { rootType: 'user', root: userMarker[1], name };
  }
  // A bare root is one principal atom: a colon inside it is some other shape (for example `<root>:app::<name>`),
  // which no principal can answer to, so it is refused here instead of parsing as a root nobody has.
  if (rawRoot.includes(':')) throw new SecretNotFoundError(ref);
  return { root: rawRoot, name };
}

/**
 * Resolve the owner candidate(s) for a parsed secret URN. A pinned user root
 * yields exactly one candidate (owner-not-found ⇒ masked not-found); a bare v2
 * root yields whichever of the org/user namespaces actually contains a
 * principal by that name (the unified pool guarantees at most one — #692/#702).
 */
async function resolveSecretOwnerCandidates(
  db: PrismaClient,
  parsed: ParsedSecretUrn,
): Promise<Array<{ ownerType: SecretOwnerType; ownerId: string }>> {
  if (parsed.rootType === 'user') {
    const user = await resolveUserRef(db, `hrn:user:${parsed.root}`); // throws UserNotFoundError
    return [{ ownerType: 'user', ownerId: user.id }];
  }
  // Bare v2 root — resolve the org and user namespaces in PARALLEL (independent
  // lookups). The unified pool (#692) will guarantee at most one principal per
  // root; a root that resolves to BOTH is AMBIGUOUS and rejected by the caller
  // (never guessed — that would be a cross-tenant leak).
  const [orgRes, userRes] = await Promise.allSettled([
    resolveOrgRef(db, parsed.root),
    resolveUserRef(db, `hrn:user:${parsed.root}`),
  ]);
  const candidates: Array<{ ownerType: SecretOwnerType; ownerId: string }> = [];
  if (orgRes.status === 'fulfilled') candidates.push({ ownerType: 'org', ownerId: orgRes.value.id });
  else if (!(orgRes.reason instanceof OrganizationNotFoundError)) throw orgRes.reason;
  if (userRes.status === 'fulfilled') candidates.push({ ownerType: 'user', ownerId: userRes.value.id });
  else if (!(userRes.reason instanceof UserNotFoundError)) throw userRes.reason;
  return candidates;
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

  if (parsed.appSlug !== undefined) {
    let appId: string;
    try {
      appId = (await resolveAppRef(db, `hrn:app:${parsed.root}:${parsed.appSlug}`)).id;
    } catch (err) {
      // Unknown / uninstalled / deleted App, or an alias that names more than one live App: all the same answer as a
      // missing secret. Only these typed outcomes are masked; operational/DB errors propagate.
      if (err instanceof AppNotFoundError || err instanceof AmbiguousLegacyUrnError) throw new SecretNotFoundError(ref);
      throw err;
    }
    const appSecret = await db.secret.findUnique({
      where: { ownerType_ownerId_name: { ownerType: 'app', ownerId: appId, name: parsed.name } },
      select: { id: true },
    });
    if (!appSecret) throw new SecretNotFoundError(ref);
    return { id: appSecret.id };
  }

  let candidates: Array<{ ownerType: SecretOwnerType; ownerId: string }>;
  try {
    candidates = await resolveSecretOwnerCandidates(db, parsed);
  } catch (err) {
    // A missing owner and a missing secret are indistinguishable — no existence
    // disclosure for a well-formed URN whose owner is absent. Only genuine
    // owner-not-found is masked; operational/DB errors propagate.
    if (err instanceof OrganizationNotFoundError || err instanceof UserNotFoundError) {
      throw new SecretNotFoundError(ref);
    }
    throw err;
  }
  if (candidates.length === 0) throw new SecretNotFoundError(ref);
  // Ambiguous bare root — both an org AND a user of that name exist, so the URN
  // doesn't name a single owner. Reject rather than guess (cross-tenant-leak
  // guard; #692's pool will make this structurally impossible). The #702 audit
  // found 0 such collisions today.
  if (candidates.length > 1) throw new SecretNotFoundError(ref);

  const owner = candidates[0]!;
  const secret = await db.secret.findUnique({
    where: {
      ownerType_ownerId_name: { ownerType: owner.ownerType, ownerId: owner.ownerId, name: parsed.name },
    },
    select: { id: true },
  });
  if (!secret) throw new SecretNotFoundError(ref);
  return { id: secret.id };
}
