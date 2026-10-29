/**
 * First-contact user provisioning for the sign-in callbacks (#442).
 *
 * Both helpers take an ALREADY-VERIFIED identity (a consumed magic-link email,
 * a GitHub profile fetched with the callback's own token) and nothing else:
 * the verification, account-linking and credential-publication steps stay in
 * the callers and are not reachable from here.
 *
 * Why a retry and not a catch-as-success: Prisma's `upsert` races on a cold
 * path (hrn:node:hadronmemory.com:dev:findings:prisma-upsert-not-race-safe).
 * Two first contacts for one identity both miss the row and both INSERT; the
 * loser's transaction aborts with P2002. Inside a PostgreSQL interactive
 * transaction that error cannot be swallowed (SQLSTATE 25P02), so the whole
 * transaction is retried from OUTSIDE the callback. The retry finds the
 * winner's row and takes the `update` branch, which for the GitHub path is a
 * real write (profile fields) that a swallow would have skipped.
 */

import type { PrismaClient } from '../generated/prisma/client.js';
import { generateUniqueHandle, isHandleTaken } from '../lib/userHandle.js';
import { ensureUserPrincipal, RootNameTakenError } from '../lib/principal/mintPrincipal.js';

/** `meta.target` spellings for each identity unique (the engine emits either mapping). */
const EMAIL_TARGETS = ['email', 'users_email_key'];
const GITHUB_ID_TARGETS = ['githubId', 'github_id', 'users_github_id_key'];
/** The handle uniques: the column unique and the `lower(handle)` functional index (what the engine reports for a case-variant). */
const HANDLE_TARGETS = ['handle', 'lower(handle)', 'users_handle_key', 'users_handle_lower_uniq'];

/**
 * True when `err` is a P2002 whose constraint is one of `targets`. A missing or
 * unrelated `meta.target` is NOT a match: only the expected unique is a race we
 * understand, so everything else propagates.
 */
export function isUniqueViolationOn(err: unknown, targets: readonly string[]): boolean {
  const e = err as { code?: unknown; meta?: { target?: unknown } } | null | undefined;
  if (e?.code !== 'P2002') return false;
  const target = e.meta?.target;
  const names = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  return names.some((n) => typeof n === 'string' && targets.includes(n));
}

/** The verified-email user, created on first contact. One retry on an email-unique race. */
export async function provisionEmailUser(db: PrismaClient, email: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      // #692: the pool principal is minted in the same tx (idempotent on the update branch).
      return await db.$transaction(async (tx) => {
        const u = await tx.user.upsert({
          where: { email },
          create: { email, identityProvider: 'EMAIL', roles: ['READER'] },
          update: {},
        });
        await ensureUserPrincipal(tx, u);
        return u;
      });
    } catch (err) {
      if (attempt < 1 && isUniqueViolationOn(err, EMAIL_TARGETS)) continue;
      throw err;
    }
  }
}

export interface ProvisionGithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

/**
 * The GitHub user for a profile with no existing row, created on first contact.
 * Each known collision is retried once: a pool-name race, a handle collision, and
 * (#442) a githubId race, so the total is finite. A retry regenerates the handle.
 */
export async function provisionGithubUser(db: PrismaClient, ghUser: ProvisionGithubProfile) {
  let retriedPool = false;
  let retriedHandle = false;
  let retriedGithubId = false;
  for (;;) {
    const ghHandle = await generateUniqueHandle(db, { seeds: [ghUser.login, ghUser.name] });
    try {
      // upsert on githubId absorbs the provider-id race on the warm path; on the
      // cold path the loser's P2002 is retried below. #692: mint the pool
      // principal in the same tx (a no-op on the update branch of an existing user).
      return await db.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { githubId: ghUser.id },
          create: {
            githubId: ghUser.id,
            githubUsername: ghUser.login,
            handle: ghHandle,
            identityProvider: 'GITHUB',
            name: ghUser.name,
            avatarUrl: ghUser.avatar_url,
            roles: ['READER'],
          },
          update: {
            githubUsername: ghUser.login,
            name: ghUser.name,
            avatarUrl: ghUser.avatar_url,
          },
        });
        await ensureUserPrincipal(tx, user);
        return user;
      });
    } catch (err: any) {
      if (err instanceof RootNameTakenError && !retriedPool) {
        retriedPool = true;
        continue;
      }
      if (isUniqueViolationOn(err, GITHUB_ID_TARGETS) && !retriedGithubId) {
        retriedGithubId = true;
        continue;
      }
      // Only a genuine handle collision is retryable (once): the error must name a handle
      // unique AND the name must be occupied now. Occupancy alone proves nothing about
      // which constraint fired, so an unknown or unrelated target never lands here.
      if (isUniqueViolationOn(err, HANDLE_TARGETS) && !retriedHandle && (await isHandleTaken(db, ghHandle))) {
        retriedHandle = true;
        continue;
      }
      throw err;
    }
  }
}
