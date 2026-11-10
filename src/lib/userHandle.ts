import { GraphQLError } from 'graphql';
import { reservedTeamPrefix } from './teamTagSnapshot.js';
/**
 * User-handle normalization (issue #325).
 *
 * A handle is the slug of the `hrn:user:<handle>` URN (spec cor:urn:010:01), so
 * it must be URN-atom-legal AND lowercase-canonical: handles are stored and
 * compared in lowercase, giving case-insensitive uniqueness (enforced by the
 * `users (lower(handle))` unique index) and predictable URNs. New / changed
 * handles go through here on write; legacy rows are grandfathered (see #325).
 */

import { randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { validateUserSlug, validateUserHandle, formatUrn } from './urn.js';
import { checkRootAvailable, ensureUserPrincipal, RootNameTakenError } from './principal/mintPrincipal.js';

/**
 * The canonical `hrn:user:<handle>` URN for a handle, or `null` when the handle
 * is absent OR not URN-legal (a grandfathered legacy row). Lowercase-canonical.
 * Single source of truth for "compute a user's URN from its handle" — used by
 * the `User.urn` GraphQL field and global search.
 */
export function userUrn(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = handle.toLowerCase();
  try {
    validateUserSlug(h);
  } catch {
    return null;
  }
  return formatUrn('user', h);
}

/**
 * Normalize a user-supplied handle to its canonical lowercase form and validate
 * it against the URN atom charset. **Throws** (`UrnParseError`) on an illegal
 * handle — use on user-facing setters where the caller should fix the input.
 */
export function normalizeHandle(input: string): string {
  const handle = input.trim().toLowerCase();
  if (reservedTeamPrefix(handle)) throw new GraphQLError('Handle mention tokens starting with team. are reserved.', { extensions: { code: 'USER_HANDLE_RESERVED_TEAM_PREFIX' } });
  // #692: a NEW/changed handle must be dot-free (validateUserHandle) so it stays
  // charset-disjoint from a dotted org root in the shared principal pool.
  validateUserHandle(handle); // throws on charset / reserved-word / dot violation
  return handle;
}

/**
 * Lenient variant for **defaulted / programmatic** handles (e.g. a GitHub login
 * copied to the handle on signup, or an app-supplied handle): returns the
 * normalized handle, or `null` when the input is empty or not URN-legal — so
 * account creation / login is never blocked by a bad handle. A null handle just
 * means the user has no URN until they set a legal one.
 */
export function normalizeHandleOrNull(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;
  const handle = input.trim().toLowerCase();
  try {
    // Deliberately LENIENT (validateUserSlug, not validateUserHandle): this
    // normalizes EXISTING / programmatic handles for read + cascade-source use,
    // so a grandfathered dotted handle (#692 is a create/rename rule) still
    // normalizes rather than vanishing to null mid-rename.
    validateUserSlug(handle);
    return handle;
  } catch {
    return null;
  }
}

/**
 * Coerce an arbitrary seed (a display name, an email local-part, an OAuth login)
 * into a URN-atom-legal handle **base**, or `null` when nothing legal survives.
 *
 * Lowercases, maps every out-of-charset run to a single `-`, trims to a start/
 * end-alnum atom, and truncates to 32 chars (a handle-specific sub-cap that
 * leaves room for a disambiguating suffix under the grammar's `MAX_ATOM_LEN`
 * (64) cap — #715). The result is re-validated through
 * the new-handle registration policy, so reserved or ID-shaped bases return
 * `null` and the caller falls through to the next seed. Spec
 * 047 (handle generation for the `@<handle>` owner namespace).
 */
export function sanitizeHandleSeed(input: string | null | undefined): string | null {
  if (!input) return null;
  const base = input
    .trim()
    .toLowerCase()
    // #692: handles are DOT-FREE — drop `.` from the kept set so a derived
    // handle (e.g. from an email local-part `first.last`) becomes `first-last`.
    .replace(/[^a-z0-9_-]+/g, '-') // out-of-charset runs (incl. `.`) → single '-'
    .replace(/^[^a-z0-9]+/, '') // atoms must start alnum
    .replace(/[^a-z0-9]+$/, '') // …and end alnum
    .slice(0, 32)
    .replace(/[^a-z0-9]+$/, ''); // re-trim a trailing sep exposed by the slice
  try {
    return normalizeHandle(base);
  } catch {
    return null;
  }
}

/** Minimal DB surface the handle probe + generator need. */
type HandleProbeDb = Pick<PrismaClient, 'principal'>;

/**
 * True when this handle is NOT available in the unified principal pool (#692) —
 * i.e. some user OR org already holds the name (case-insensitively, including a
 * tombstoned/released row), or it is a reserved platform word. This replaced the
 * users-only probe so an auto-generated handle can never collide with an org
 * name. The `principals_name_lower_uniq` index remains the atomic backstop; this
 * probe just avoids picking a doomed name. Exported so signup paths can
 * distinguish a handle collision (retryable) from any other conflict.
 */
export async function isHandleTaken(db: HandleProbeDb, handle: string): Promise<boolean> {
  return !(await checkRootAvailable(db, handle));
}

/**
 * Produce a URN-atom-legal handle that is not currently taken, for signup paths
 * that must set `User.handle` (NOT NULL under spec 047). Tries each `seeds`
 * entry in order (a name, an email local-part, an OAuth login) plus an optional
 * `fallback`, and returns the first legal, currently-free one (`holger`).
 *
 * On collision — or when no seed is usable — it disambiguates with a **random**
 * token, never a sequential suffix (a `-2`/`-7` ladder would leak signup order
 * and user count). A readable stem is kept when we have one
 * (`holger-a3f91c04`); with no usable seed at all it returns a short bare
 * random handle. Handles are user-editable, so an ugly one is fine.
 *
 * The DB `lower(handle)` unique index remains the real guard: on the rare
 * concurrent-signup race two callers can pick the same free handle, and the
 * loser's `create` throws P2002 — the OAuth paths retry, regenerating.
 */
export async function generateUniqueHandle(
  db: HandleProbeDb,
  opts: { seeds?: Array<string | null | undefined>; fallback?: string } = {},
): Promise<string> {
  const bases: string[] = [];
  for (const seed of [...(opts.seeds ?? []), opts.fallback]) {
    const base = sanitizeHandleSeed(seed);
    if (base && !bases.includes(base)) bases.push(base);
  }

  // 1. A free, readable, seed-derived handle is ideal.
  for (const base of bases) {
    if (!(await isHandleTaken(db, base))) return base;
  }

  // 2. Collision or no usable seed: random entropy, never a sequential suffix.
  //    Keep a readable stem when we have one; otherwise a bare random handle.
  const stem = bases[0]; // undefined when every seed was illegal/reserved
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = stem
      ? `${stem.slice(0, 40)}-${randomBytes(4).toString('hex')}`
      : randomBytes(6).toString('hex');
    // Fresh candidates use registration policy; stored-handle reads stay lenient.
    let legal: string | null;
    try {
      legal = normalizeHandle(candidate);
    } catch {
      legal = null;
    }
    if (legal && !(await isHandleTaken(db, legal))) return legal;
  }
  throw new Error('generateUniqueHandle: could not find a free handle');
}

/** DB surface for {@link ensureUserHandle}: the handle probe, the `user`
 * delegate it reads/persists the handle on, plus what {@link ensureUserPrincipal}
 * needs to mint+link the pool principal. */
type EnsureHandleDb = HandleProbeDb & Pick<PrismaClient, 'user'>;

/**
 * Return the user's canonical (lowercase) handle and guarantee the unified
 * principal-pool row (#692) exists for it. This is the "the caller owns
 * something in their own `@handle` namespace" entry point — a user-owned
 * Memory/App/Agent URN roots on the owner's handle, and the pool principal is
 * the uniqueness authority, so both must exist before that URN is minted.
 *
 * `User.handle` is NON-NULL (schema `@default(dbgenerated(...))`), so every user
 * already has a handle — there is no handle-less user to fill and no
 * observe-null-then-generate race (a point raised in #762 review that the
 * NOT-NULL column rules out). The common path therefore just canonicalizes the
 * existing handle and, via the idempotent {@link ensureUserPrincipal}, links its
 * pool principal (a user created off the signup path can have the default handle
 * but no principal — the gap #762 review flagged). A grandfathered mixed-case
 * legacy handle is rooted on its **lowercase** form (matching `userUrn`) but is
 * NOT rewritten in place — identity is not mutated as a side effect of memory
 * creation.
 *
 * The fallback loop handles only the rare grandfathered handle that is not
 * URN-legal at all (pre-#325): a URN cannot root on it, so a fresh legal handle
 * is minted through the pool (atomic claim) and persisted.
 */
export async function ensureUserHandle(db: EnsureHandleDb, userId: string): Promise<string> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, handle: true, name: true, email: true, principalId: true },
  });

  // Common path: the (always-present) handle is URN-legal. Root on its lowercase
  // form and make sure the pool principal exists so root and pool never drift.
  const canonical = userUrn(user.handle) ? user.handle.toLowerCase() : null;
  if (canonical) {
    await ensureUserPrincipal(db, { id: user.id, handle: canonical, principalId: user.principalId });
    return canonical;
  }

  // Rare: a grandfathered non-URN-legal handle (pre-#325). A URN can't root on
  // it, so mint a fresh legal handle through the pool (the create is the atomic
  // claim — RootNameTakenError ⇒ retry) and persist it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await generateUniqueHandle(db, {
      seeds: [user.name, user.email ? user.email.split('@')[0] : null],
    });
    try {
      await ensureUserPrincipal(db, { id: user.id, handle: candidate, principalId: null });
    } catch (err) {
      if (err instanceof RootNameTakenError) continue;
      throw err;
    }
    await db.user.update({ where: { id: userId }, data: { handle: candidate } });
    return candidate;
  }
  throw new Error('ensureUserHandle: could not assign a URN-legal handle');
}
