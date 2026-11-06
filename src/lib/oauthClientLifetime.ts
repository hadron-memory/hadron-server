/**
 * #155: how long an unused DCR OAuth client lives, and the one predicate for
 * "this client may still be used". Registration sets `expiresAt` to
 * {@link oauthClientExpiresAt}; each token redemption pushes it forward; the
 * GC (src/jobs/gcOauthClients.ts) soft-deletes a client
 * {@link OAUTH_CLIENT_GC_GRACE_MS} past it. A NULL `expiresAt` never expires.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** An unused client's lifetime from registration or its last redemption. */
export const OAUTH_CLIENT_TTL_MS = 30 * DAY_MS;

/** How long past `expiresAt` the GC waits before collecting a client. */
export const OAUTH_CLIENT_GC_GRACE_MS = 7 * DAY_MS;

export function oauthClientExpiresAt(nowMs: number = Date.now()): Date {
  return new Date(nowMs + OAUTH_CLIENT_TTL_MS);
}

/**
 * Whether a looked-up client may be used: it exists and is not soft-deleted.
 * Shared by /authorize (validateClientAndRedirectUri) and /token, so the two
 * cannot drift again (#155: /token never checked it).
 */
export function isLiveOAuthClient<T extends { deletedAt: Date | null }>(client: T | null | undefined): client is T {
  return !!client && client.deletedAt === null;
}
