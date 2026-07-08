import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';
import type { PrismaClient, UserApiKey } from '../generated/prisma/index.js';
import { verifyJwt } from '../auth/jwt.js';

export interface AuthContext {
  clientId?: string;       // "github:<username>" / "email:<addr>" — only set for OAuth/JWT users
  userId?: string;         // User.id — only set for OAuth/JWT users
  appId?: string;          // App.id — set when caller authenticated via an App Key
  sessionId?: string;      // Session.id — set when operating inside an active session
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
  apiKeyId?: string;       // UserApiKey.id — set when a user authenticated via an hdr_user_ key (not JWTs)
}

// App Keys use a distinct prefix so the middleware can route them without
// ambiguity. The raw key is `hdr_app_<64 hex chars>`.
export const APP_KEY_PREFIX = 'hdr_app_';

// User API Keys (spec 025-oauth-for-mcp): user-scoped credential issued
// either portal-side (createUserApiKey GraphQL mutation) or by the OAuth
// /token endpoint. Same SHA-256 hashing primitive as AppKey; resolves to
// a User instead of an App. The raw key is `hdr_user_<64 hex chars>`.
export const USER_API_KEY_PREFIX = 'hdr_user_';

/**
 * Cap on `UserApiKey.label`. The Prisma column is uncapped TEXT;
 * 200 chars is plenty for a human-readable display name and prevents
 * megabyte-sized labels from being persisted. Both `mintUserApiKey`
 * callsites (GraphQL `createUserApiKey` + OAuth `/oauth/token`) cap
 * the label they pass in.
 */
export const USER_API_KEY_LABEL_MAX_LEN = 200;

export function hashAppKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function hashUserApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// Resolve auth context from an incoming request.
// JWTs (contain dots) → OAuth user; `hdr_app_` → App; `hdr_user_` → User.
//
// **Bearer-token-only by design.** Spec 025 FR-007 sets a server-domain
// `hadron_token` cookie via the GitHub OAuth callback's Option-C path
// (see src/server.ts /auth/github/callback). That cookie exists so the
// AS-domain /oauth/authorize consent screen (Phase 2) can authenticate
// the user. It is **NOT** an alternative auth source for /mcp or
// /graphql. This middleware MUST NOT learn to accept cookies — doing so
// would silently bypass the explicit Bearer-token requirement at every
// MCP and GraphQL boundary, and (worse) would expose those surfaces to
// CSRF attacks (cookies travel automatically with cross-origin
// requests; bearer tokens require explicit attachment). Any future
// "cookie auth" feature MUST be scoped to a separate middleware
// mounted only on the consent-screen routes.
export async function resolveAuthContext(
  req: Request,
  db: PrismaClient,
): Promise<AuthContext> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return {};

  const token = authHeader.slice(7);

  if (token.startsWith(APP_KEY_PREFIX)) {
    const sessionIdHeader = req.headers['x-hadron-session'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    return resolveAppKey(token, db, sessionId);
  }

  if (token.startsWith(USER_API_KEY_PREFIX)) {
    return resolveUserApiKey(token, db);
  }

  // JWTs have the form header.payload.signature — three base64url segments.
  const isJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  if (isJwt) {
    return resolveJwt(token);
  }
  return {};
}

async function resolveAppKey(
  rawKey: string,
  db: PrismaClient,
  sessionId?: string,
): Promise<AuthContext> {
  // App keys are hashed via SHA-256 (not bcrypt) because we look them up by
  // hash — bcrypt's per-hash salt makes that impossible at any useful scale.
  // SHA-256 is fine here because the raw key is a 256-bit random value, so
  // dictionary/rainbow attacks against the hash are not a concern.
  const keyHash = hashAppKey(rawKey);
  const appKey = await db.appKey.findUnique({
    where: { keyHash },
    include: { app: true },
  });
  if (!appKey || appKey.revokedAt || appKey.app.deletedAt) return {};

  // Fire-and-forget lastUsedAt update
  db.appKey
    .update({ where: { id: appKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  const ctx: AuthContext = {
    appId: appKey.app.id,
    organizationId: appKey.app.organizationId,
    // App Keys carry no explicit roles; org-level checks are enforced per-call
    // by the resolvers against the app's organization.
    roles: [],
  };

  if (sessionId) {
    // Validate the session belongs to this app and is still active.
    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: { id: true, appId: true, expiresAt: true, endedAt: true },
    });
    if (
      session &&
      session.appId === appKey.app.id &&
      !session.endedAt &&
      (!session.expiresAt || session.expiresAt > new Date())
    ) {
      ctx.sessionId = session.id;
    }
  }

  return ctx;
}

// Valid runtime values for AuthContext.roles. Mirrors the Prisma `Role`
// enum exactly (prisma/schema.prisma `enum Role { OWNER ADMIN
// CONTRIBUTOR READER }`). Used to filter User.roles at the middleware
// boundary so any drift between DB content and the type annotation
// can't smuggle unknown role strings into request context.
const ALLOWED_ROLES = new Set<NonNullable<AuthContext['roles']>[number]>([
  'OWNER',
  'ADMIN',
  'CONTRIBUTOR',
  'READER',
]);

async function resolveUserApiKey(
  rawKey: string,
  db: PrismaClient,
): Promise<AuthContext> {
  // Length precheck: tokens are USER_API_KEY_PREFIX + 64 hex chars.
  // Reject anything else without touching the DB — cheap defense
  // against garbage-token probing.
  if (rawKey.length !== USER_API_KEY_PREFIX.length + 64) return {};

  // Same hash-lookup pattern as AppKey: SHA-256 over the 256-bit raw key,
  // direct lookup by hash. bcrypt would prevent the lookup; the raw key's
  // entropy makes dictionary attacks against the hash a non-issue.
  const keyHash = hashUserApiKey(rawKey);
  const userApiKey = await db.userApiKey.findUnique({
    where: { keyHash },
    include: { user: true },
  });
  if (!userApiKey || userApiKey.revokedAt || userApiKey.user.deletedAt) {
    // Revoked / deleted-user keys fail authentication identically to
    // unknown keys — no information leakage per spec Edge Cases.
    return {};
  }

  // Fire-and-forget lastUsedAt update; failures are non-fatal.
  db.userApiKey
    .update({ where: { id: userApiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  // Synthesize clientId from the resolved User. Prefer GitHub username
  // (matches the JWT path's `github:<username>`); fall back to email,
  // then to the opaque user-id form.
  const user = userApiKey.user;
  const clientId = user.githubUsername
    ? `github:${user.githubUsername}`
    : user.email
      ? `email:${user.email}`
      : `user:${user.id}`;

  // User.roles is typed Role[] by Prisma. Filter to the runtime
  // allow-list as defense in depth against any DB drift (direct SQL,
  // legacy data, future enum-value additions). `appId` is intentionally
  // absent — App resolution for user credentials happens at the MCP
  // boundary per FR-020, not in auth middleware.
  const validatedRoles = (user.roles as readonly string[]).filter(
    (r): r is NonNullable<AuthContext['roles']>[number] =>
      ALLOWED_ROLES.has(r as NonNullable<AuthContext['roles']>[number]),
  );

  return {
    userId: user.id,
    clientId,
    roles: validatedRoles,
    // The specific credential presented on this request (issue #562). Lets the
    // authContext query name the exact key (label, keyPreview, lastUsedAt,
    // revokedAt). JWT-authenticated users have no UserApiKey, so this stays
    // unset on that path.
    apiKeyId: userApiKey.id,
  };
}

/**
 * Single insert path for `UserApiKey` rows (spec 025 FR-015). Both the
 * portal-side `createUserApiKey` GraphQL resolver and the OAuth
 * `POST /oauth/token` handler call this so the hashing primitive,
 * prefix, entropy, and persisted-field shape never drift between paths
 * — that's the structural guarantee behind "single validation path"
 * (FR-003): the token produced by either caller validates identically
 * via `resolveUserApiKey` above.
 *
 * The raw key is returned exactly once. Callers MUST hand it to the
 * end user immediately; only the hash is persisted, so a lost raw key
 * is unrecoverable by design.
 *
 * Callers supply:
 *   - `userId`     — owning User.id (FK to User)
 *   - `label`      — caller-visible name (`null` allowed; capped at the
 *                    callsite per surface — GraphQL resolver caps to
 *                    USER_API_KEY_LABEL_MAX_LEN, OAuth path constructs
 *                    a `"OAuth: <clientName>"` label)
 *   - `createdBy`  — actor User.id (REV-2; usually equals `userId`)
 *   - `issuedVia`  — path discriminator (REV-2; `'portal'` for the
 *                    portal mutation, `'oauth:<clientId>'` for the
 *                    OAuth token endpoint)
 */
export interface MintUserApiKeyInput {
  userId: string;
  label: string | null;
  createdBy: string;
  issuedVia: string;
}

export interface MintUserApiKeyResult {
  rawKey: string;
  userApiKey: UserApiKey;
}

export async function mintUserApiKey(
  db: PrismaClient,
  input: MintUserApiKeyInput,
): Promise<MintUserApiKeyResult> {
  // 32 bytes / 256 bits / 64 hex chars + the hdr_user_ prefix. Same
  // entropy as AppKey; same length precheck in `resolveUserApiKey`
  // above (USER_API_KEY_PREFIX.length + 64 chars).
  const rawKey = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
  const keyHash = hashUserApiKey(rawKey);
  const keyPreview = rawKey.slice(-4);
  const userApiKey = await db.userApiKey.create({
    data: {
      userId: input.userId,
      keyHash,
      keyPreview,
      label: input.label,
      createdBy: input.createdBy,
      issuedVia: input.issuedVia,
    },
  });
  return { rawKey, userApiKey };
}

async function resolveJwt(token: string): Promise<AuthContext> {
  try {
    const payload = await verifyJwt(token);
    const clientId = payload.githubUsername
      ? `github:${payload.githubUsername}`
      : `email:${payload.email}`;
    return {
      clientId,
      userId: payload.sub,
      roles: payload.roles,
    };
  } catch {
    return {}; // invalid or expired JWT
  }
}
