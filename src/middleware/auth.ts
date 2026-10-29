import { ownsSession } from '../lib/sessionOwnership.js';
import { createHash, randomBytes } from 'crypto';
import { DEFAULT_SESSION_DORMANCY_DAYS, isSessionDormant, loadLastEventBySession } from '../lib/sessionActivity.js';
import type { Request } from 'express';
import type { Prisma, PrismaClient, UserApiKey } from '../generated/prisma/index.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { type verifyJwt } from '../auth/jwt.js';
import { verifyAuthenticatedJwt, lockLiveSignInRoot } from '../auth/signIn.js';
import type { HadronJwtPayload } from '../auth/jwt.js';
import { canImpersonate, type ImpersonationContext } from '../lib/auth/impersonation.js';
import { LIVE_ORG_MEMBERSHIP } from '../lib/auth/liveOrgMembership.js';
import { publishActor, publishUser } from '../lib/requestActor.js';

export interface AuthContext {
  login?: HadronJwtPayload['login'];
  clientId?: string;       // "github:<username>" / "email:<addr>" — only set for OAuth/JWT users
  userId?: string;         // User.id — only set for OAuth/JWT users
  appId?: string;          // App.id — set when caller authenticated via an App Key
  /**
   * AppKey.id — set ONLY when the caller authenticated with an `hdr_app_` key (#1749). `appId` alone cannot say which:
   * a person's active-App selection sets it too. The wake proof binds this, and the audit names it. A scope the key
   * holds is never copied here: it is read from the database at every surface it gates, so a revocation holds over a
   * transport that keeps this context open.
   */
  appKeyId?: string;
  sessionId?: string;      // Session.id — set when operating inside an active session
  /**
   * #1705 — the request NAMED a session (X-Hadron-Session) that did not
   * validate, so `sessionId` is unset and the request proceeds unbound (the
   * pre-existing silent-drop behaviour, unchanged). A surface whose actor is
   * the session's worker reads this to refuse rather than act as the bare
   * credential: a worker whose session ended must not silently become its
   * human driver (agent tasks, cor:agt:050:08).
   */
  sessionBindingRefused?: boolean;
  /**
   * An MCP transport keeps its initialization context. The transport refreshes
   * this binding result for BOTH principal shapes before each dispatch under
   * its request lock. Session-sensitive tools use mcpRequestSessionContext,
   * preserving initialization refusal without changing retained attribution.
   */
  requestSession?: { sessionId?: string; refused: boolean };
  // Current User-row roles for ordinary user principals. HTTP auth resolves
  // them per request; an existing MCP transport refreshes them before every
  // request because its AuthContext otherwise outlives the credential check.
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
  /** #1897: the live factor-protected sign-in this credential descends from (JWT `sid` or key root). */
  signInId?: string;
  apiKeyId?: string;       // UserApiKey.id — set when a user authenticated via an hdr_user_ key (not JWTs)
  /**
   * OAuth scopes bound to the presented `hdr_user_` key. Absent for JWTs,
   * App keys, and legacy/portal user keys whose empty scope list deliberately
   * means full user authority (cor:aut:010:02). Unknown non-empty values are
   * preserved so the surface gate below fails closed rather than silently
   * treating future or corrupt values as unscoped.
   */
  oauthScopes?: string[];
  /**
   * Set when the request authenticated with an impersonation JWT: `userId` is
   * the TARGET user, `roles` is `[]`, and this carries the session + the
   * admin actor + the single org the session may see into. Read surfaces
   * consult it to narrow scope; mutations are blocked wholesale (Apollo
   * plugin); /mcp rejects it at session init.
   */
  impersonation?: ImpersonationContext;
}

// App Keys use a distinct prefix so the middleware can route them without
// ambiguity. The raw key is `hdr_app_<64 hex chars>`.
export const APP_KEY_PREFIX = 'hdr_app_';

// User API Keys (spec 025-oauth-for-mcp): user-scoped credential issued
// either portal-side (createUserApiKey GraphQL mutation) or by the OAuth
// /token endpoint. Same SHA-256 hashing primitive as AppKey; resolves to
// a User instead of an App. The raw key is `hdr_user_<64 hex chars>`.
export const USER_API_KEY_PREFIX = 'hdr_user_';

/** OAuth scope names supported by the authorization server. */
export const SUPPORTED_OAUTH_SCOPES = ['mcp', 'account'] as const;
export type OAuthScope = (typeof SUPPORTED_OAUTH_SCOPES)[number];
export type OAuthSurface = 'mcp' | 'account';

/**
 * Enforce the immutable OAuth grant attached to a user API key.
 *
 * An empty/absent list is intentionally unrestricted for portal-minted and
 * legacy credentials. `account` is the broad grant and is valid anywhere a
 * user credential is accepted; `mcp` is valid only at the MCP boundary.
 * Unknown non-empty values match neither branch and therefore fail closed.
 */
export function authContextAllowsOAuthSurface(
  auth: Pick<AuthContext, 'oauthScopes'>,
  surface: OAuthSurface,
): boolean {
  const scopes = auth.oauthScopes;
  if (!scopes || scopes.length === 0) return true;
  if (scopes.some((scope) => !SUPPORTED_OAUTH_SCOPES.includes(scope as OAuthScope))) {
    return false;
  }
  if (scopes.includes('account')) return true;
  return surface === 'mcp' && scopes.includes('mcp');
}

/**
 * WHY a credential is refused a surface, as data (#1303). Additive to the
 * existing refusals: their `code` (FORBIDDEN) and prose are unchanged, so a
 * client matching either keeps working; a client can now match `reason`
 * instead of prose, and tell this apart from an ordinary permission denial.
 *
 * Two causes that used to share one sentence:
 * - `OAUTH_SCOPE_INSUFFICIENT`: every scope is supported, and none grants
 *   `surface` (today: an `mcp`-only key on an account surface).
 * - `OAUTH_SCOPE_UNSUPPORTED`: the grant carries a scope this server does not
 *   support, so it fails closed whatever else it carries.
 *
 * `grantedScopes` names scopes, never a key. PROVISIONAL NAMES, pending the
 * CLI owner and the specs engineer (team chat #1292).
 */
export interface OAuthSurfaceRefusal {
  reason: 'OAUTH_SCOPE_INSUFFICIENT' | 'OAUTH_SCOPE_UNSUPPORTED';
  requiredScope: OAuthScope;
  grantedScopes: string[];
  unsupportedScopes?: string[];
}

/** The refusal for `surface`, or null when `authContextAllowsOAuthSurface` admits it. */
export function oauthSurfaceRefusal(
  auth: Pick<AuthContext, 'oauthScopes'>,
  surface: OAuthSurface,
): OAuthSurfaceRefusal | null {
  if (authContextAllowsOAuthSurface(auth, surface)) return null;
  const granted = [...(auth.oauthScopes ?? [])];
  const unsupported = granted.filter((scope) => !SUPPORTED_OAUTH_SCOPES.includes(scope as OAuthScope));
  return unsupported.length > 0
    ? { reason: 'OAUTH_SCOPE_UNSUPPORTED', requiredScope: surface, grantedScopes: granted, unsupportedScopes: unsupported }
    : { reason: 'OAUTH_SCOPE_INSUFFICIENT', requiredScope: surface, grantedScopes: granted };
}

/**
 * The human sentence for a surface refusal (#1303). OAUTH_SCOPE_INSUFFICIENT
 * keeps each surface's EXISTING prose byte for byte, because deployed clients
 * match it; OAUTH_SCOPE_UNSUPPORTED gets its own sentence, because it is a
 * different cause with a different remedy, and sharing the MCP-only prose made
 * today's CLI mislabel it (hadron-cli, PR #1306 review).
 */
export function oauthSurfaceRefusalMessage(refusal: OAuthSurfaceRefusal, insufficientProse: string): string {
  if (refusal.reason === 'OAUTH_SCOPE_INSUFFICIENT') return insufficientProse;
  const scopes = (refusal.unsupportedScopes ?? []).map((s) => JSON.stringify(s)).join(', ');
  return `This OAuth credential carries a scope this server does not support (${scopes}), so it is refused everywhere. Sign in again to get a credential with supported scopes.`;
}

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
  const sessionIdHeader = req.headers['x-hadron-session'];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  let ctx: AuthContext;
  if (token.startsWith(APP_KEY_PREFIX)) {
    ctx = await resolveAppKey(token, db);
  } else if (token.startsWith(USER_API_KEY_PREFIX)) {
    ctx = await resolveUserApiKey(token, db);
  } else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    // JWTs have the form header.payload.signature — three base64url segments.
    ctx = await resolveJwt(token, db);
  } else {
    return {};
  }

  if (sessionId) await bindSession(db, ctx, sessionId);
  // #2176: the validated user behind this request's writes, from the SAME resolved context
  // `editorFromAuth` reads for the revision, never from anything the client asserts.
  publishUser(ctx.userId ?? null);
  return ctx;
}

/**
 * Bind the `X-Hadron-Session` header to the resolved principal (#934, amending
 * `cor:aut:020:02`) — ONE binding path for both principal shapes, so the honor
 * conditions (active: not ended, not past a hard expiry) can never drift:
 *
 *   - **App-key** (pure — no userId by construction): the session must belong
 *     to the App. The original cor:aut:020:02 rule, unchanged.
 *   - **User credential** (hdr_user_ key or JWT): the session must be
 *     ATTRIBUTED TO this user — strict `session.userId === ctx.userId`, no
 *     platform-admin bypass, and never under impersonation (a support session
 *     heartbeating the target's coding session would be attribution theater).
 *     Ownership replaces App-membership as the predicate because the sessions
 *     this exists for — user-credential MCP coding sessions — are
 *     self-attributed with `appId: null`.
 *
 * Binding stays ATTRIBUTION, never a credential: it feeds the usage-event
 * heartbeat the #930 reaper counts (#933 fixed the writers; this fixes the
 * missing binding for user principals, whose continuously-busy MCP sessions
 * otherwise read as idle and get reaped — freeing their Worker mid-work,
 * cor:agt:020:03). It must never widen what the caller may do: the
 * session-scope branch in `getAccessibleMemoryIds` (and its MCP twin) is
 * gated on the PURE App-key shape, so a user principal's binding leaves their
 * memory reach exactly their user reach (the #967 narrow-never-grant posture,
 * mirrored for user principals).
 *
 * An invalid binding is silently dropped (the request proceeds unbound) —
 * the pre-existing App-key behavior, kept identical for both shapes.
 */
async function bindSession(
  db: PrismaClient,
  ctx: AuthContext,
  sessionId: string,
): Promise<void> {
  const bound = await validateSessionBinding(db, ctx, sessionId);
  if (!bound) {
    ctx.sessionBindingRefused = true;
    return;
  }
  ctx.sessionId = bound.sessionId;
  // #1610: the Worker / Agent behind this request's writes comes from the
  // binding just validated — the one thing a client cannot assert.
  publishActor(bound.actor);
}

/**
 * The ONE ownership check behind every session binding (#934): the header
 * above, and the MCP connection binding `hadron_start_session` sets (DAC,
 * #1610 follow-on), which re-validates it on every request. An active session
 * (not ended, not past a hard expiry, not DORMANT) of the caller's own: an App
 * key's own App's session, or a user's own session, never under
 * impersonation. Returns null for anything else.
 */
export async function validateSessionBinding(
  db: PrismaClient,
  principal: AuthContext,
  sessionId: string,
): Promise<{ sessionId: string; actor: { workerId: string | null; agentId: string | null } } | null> {
  const isPureAppKey = !!principal.appId && !principal.userId;
  const isUserPrincipal = !!principal.userId && !principal.impersonation;
  if (!isPureAppKey && !isUserPrincipal) return null;
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true, appId: true, userId: true, expiresAt: true, endedAt: true, workerId: true, agentId: true,
      startedAt: true, updatedAt: true, autoExpiredAt: true, launchOperationId: true,
      app: { select: { sessionDormancyDays: true } },
    },
  });
  if (!session || session.endedAt) return null;
  const now = new Date();
  if (session.expiresAt && session.expiresAt <= now) return null;
  if (!ownsSession(principal, session)) return null;
  // Ruling DY-5, completed for sessions with NO hard expiry (#1661 review,
  // Rook P2-1): a session nobody has driven for longer than its App's
  // dormancy threshold no longer binds. Without this, an App with
  // `agentSessionsExpire: false` left a chatbot session, and its session-
  // scoped reach into an end user's personal memory, bindable by any key of
  // that App forever: Holger's "5 year old session, forgotten by everyone,
  // starts acting unexpectedly". A session WITH a hard expiry is already
  // bounded by it. Only an explicit new session brings a dormant one back.
  // Here, in the ONE check, so it guards BOTH doors: the X-Hadron-Session
  // header and the MCP connection binding (#1665): a dormant session neither
  // binds nor attributes writes.
  if (!session.expiresAt) {
    const lastEvent = (await loadLastEventBySession(db as never, [session.id])).get(session.id);
    const days = session.app?.sessionDormancyDays ?? DEFAULT_SESSION_DORMANCY_DAYS;
    if (isSessionDormant(session, lastEvent, days, now)) return null;
  }
  return { sessionId: session.id, actor: { workerId: session.workerId, agentId: session.agentId } };
}

async function resolveAppKey(
  rawKey: string,
  db: PrismaClient,
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

  // Session binding (X-Hadron-Session) is applied by the caller via
  // `bindSession` — #934 unified it across principal shapes.
  return {
    appId: appKey.app.id,
    appKeyId: appKey.id,
    // A user-owned App (spec 047) has no organizationId — undefined
    // matches the field's existing "unscoped" convention.
    organizationId: appKey.app.organizationId ?? undefined,
    // App Keys carry no explicit roles; org-level checks are enforced per-call
    // by the resolvers against the app's organization.
    roles: [],
  };
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

function validatedUserRoles(roles: readonly string[]): NonNullable<AuthContext['roles']> {
  return roles.filter(
    (role): role is NonNullable<AuthContext['roles']>[number] =>
      ALLOWED_ROLES.has(role as NonNullable<AuthContext['roles']>[number]),
  );
}

/**
 * Read an ordinary user's CURRENT platform roles (#1251).
 *
 * JWT claims and an MCP transport's AuthContext are both snapshots. The user
 * row is the authority for role-sensitive work, so long-lived surfaces call
 * this at their request boundary instead of trusting either snapshot.
 * Impersonation is deliberately never upgraded through the target user's row.
 */
export async function getCurrentUserRoles(
  db: PrismaClient,
  auth: Pick<AuthContext, 'userId' | 'impersonation'>,
): Promise<NonNullable<AuthContext['roles']> | null> {
  if (!auth.userId || auth.impersonation) return [];
  const user = await db.user.findFirst({
    where: { id: auth.userId, deletedAt: null },
    select: { roles: true },
  });
  // `null` is deliberately distinct from an ordinary user with no platform
  // roles. Long-lived MCP transports retain the authenticated identity fields,
  // so collapsing a deleted user to [] would leave that identity usable by
  // every non-role-based tool after account deletion.
  return user ? validatedUserRoles(user.roles) : null;
}

export async function hasCurrentPlatformAdminRole(
  db: PrismaClient,
  auth: Pick<AuthContext, 'userId' | 'impersonation'>,
): Promise<boolean> {
  const roles = await getCurrentUserRoles(db, auth);
  return roles?.includes('ADMIN') === true || roles?.includes('OWNER') === true;
}

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
    include: { user: true, originSignIn: { select: { endedAt: true } } },
  });
  // #1897: a key descending from an ended sign-in is dead even if its own row was not yet stamped.
  if (!userApiKey || userApiKey.revokedAt || userApiKey.user.deletedAt || userApiKey.originSignIn?.endedAt) {
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
  const validatedRoles = validatedUserRoles(user.roles);

  return {
    userId: user.id,
    clientId,
    roles: validatedRoles,
    // The specific credential presented on this request (issue #562). Lets the
    // authContext query name the exact key (label, keyPreview, lastUsedAt,
    // revokedAt). JWT-authenticated users have no UserApiKey, so this stays
    // unset on that path.
    apiKeyId: userApiKey.id,
    ...(userApiKey.originSignInId ? { signInId: userApiKey.originSignInId } : {}),
    ...(userApiKey.oauthScopes.length > 0
      ? { oauthScopes: userApiKey.oauthScopes }
      : {}),
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
 *   - `issuedVia`  — issuance identity: portal for sign-in, oauth:<clientId>
 *                    for OAuth; inherited (including unknown/null) from
 *                    an authenticated parent on key-authenticated minting
 *   - `oauthScopes` — immutable OAuth grant copied from AuthCode;
 *                     omitted/empty for portal and legacy keys
 */
export interface MintUserApiKeyInput {
  userId: string;
  label: string | null;
  createdBy: string;
  issuedVia: string | null;
  oauthScopes?: readonly OAuthScope[];
  /** Server-derived authenticated parent; root issuance leaves it null. */
  mintedByKeyId?: string;
  /**
   * #1897 / R66: the factor-protected sign-in this key descends from, set only from authenticated
   * server context (the claimed code's root, the JWT's `sid`). A key minted by another key always
   * inherits that key's root, whatever is passed here. Null = direct or legacy; never inferred.
   */
  originSignInId?: string | null;
}

export interface MintUserApiKeyResult {
  rawKey: string;
  userApiKey: UserApiKey;
}

export async function mintUserApiKey(
  db: PrismaClient,
  input: MintUserApiKeyInput,
): Promise<MintUserApiKeyResult> {
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: input.userId }], 'shared');
    const live = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${input.userId} AND deleted_at IS NULL FOR SHARE`;
    if (!live[0]) throw new Error('User not found');
    return mintUserApiKeyInTx(tx, input);
  });
}

/** The GraphQL authority transaction already holds the user anchor. */
export async function mintUserApiKeyInTx(
  db: Pick<Prisma.TransactionClient, 'userApiKey' | '$queryRaw'>,
  input: MintUserApiKeyInput,
): Promise<MintUserApiKeyResult> {
  // R66: a descendant never sheds its root, and nothing is minted under an ended one. The caller
  // holds the user authority anchor, so cancellation cannot interleave with this read-then-insert.
  let originSignInId = input.originSignInId ?? null;
  if (input.mintedByKeyId) {
    const parent = await db.$queryRaw<Array<{ origin_sign_in_id: string | null }>>`
      SELECT origin_sign_in_id FROM user_api_keys
      WHERE id = ${input.mintedByKeyId} AND user_id = ${input.userId} FOR SHARE`;
    if (!parent[0]) throw new Error('Minting key not found');
    if (originSignInId && parent[0].origin_sign_in_id !== originSignInId) throw new Error('Sign-in root mismatch');
    originSignInId = parent[0].origin_sign_in_id;
  }
  if (originSignInId) await lockLiveSignInRoot(db, originSignInId, input.userId);
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
      mintedByKeyId: input.mintedByKeyId ?? null,
      originSignInId,
      oauthScopes: input.oauthScopes ? [...input.oauthScopes] : [],
    },
  });
  return { rawKey, userApiKey };
}

async function resolveJwt(token: string, db: PrismaClient): Promise<AuthContext> {
  try {
    const payload = await verifyAuthenticatedJwt(token, db);
    // Impersonation tokens branch FIRST and own every liveness check they
    // need, including the target's. Ordering is load-bearing: `payload.sub`
    // is the TARGET on this path, so running the generic check below first
    // would return early when the target's account is deleted — killing the
    // token correctly, but skipping the revocation stamp and leaving the
    // audit trail reporting the session live until TTL (#878, PR #879 review).
    if (payload.imp) {
      return resolveImpersonationJwt(payload, db);
    }
    // A JWT is self-contained, but account liveness AND platform roles are
    // live authority. Re-read both on every request: otherwise deleteUser
    // #662 would leave the credential live, and #1251 would leave a demoted
    // ADMIN/OWNER authorized until the signed claim expired.
    const user = await db.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: { id: true, roles: true },
    });
    if (!user) return {};
    const clientId = payload.githubUsername
      ? `github:${payload.githubUsername}`
      : `email:${payload.email}`;
    return {
      clientId,
      userId: payload.sub,
      login: payload.login,
      ...(payload.sid ? { signInId: payload.sid } : {}),
      roles: validatedUserRoles(user.roles),
    };
  } catch {
    return {}; // invalid, expired or ended-sign-in JWT
  }
}

/**
 * Resolve an impersonation JWT (payload carries `imp`) to a scoped
 * AuthContext, or `{}`. The signed claim only NAMES the session — the
 * ImpersonationSession row is authoritative and every condition is re-checked
 * from the DB per request, so ending the session, TTL lapse, demoting or
 * removing the admin, or removing the target from the org each kills the
 * token immediately. Every failure mode returns `{}` indistinguishably from
 * a bad token (no reason-leak, matching the credential-resolution posture).
 *
 * A resolved context has `userId` = target, `roles: []` (never the target's
 * platform roles — no privilege inheritance), and `impersonation` set.
 */
/**
 * Mark a session ended because its authorization was REVOKED (issue #878) —
 * the admin lost their role, the target was promoted past peer-or-below, the
 * target left the org, or the admin's account was deleted.
 *
 * Without this the row keeps looking live until its TTL: `isActive` and the
 * `activeOnly` filter are derived from `endedAt IS NULL AND expiresAt > now`,
 * so an operator checking "which sessions are live right now?" — typically
 * right after revoking someone's role, precisely because they no longer trust
 * them — was told one still was. The token was already dead; only the audit
 * trail disagreed.
 *
 * `endedBy` is deliberately left NULL. Combined with `endedAt` that encodes
 * the three end states distinguishably, with no extra column:
 *   - endedAt set + endedBy set   → a person explicitly stopped it
 *   - endedAt set + endedBy NULL  → the system revoked it (this path)
 *   - endedAt NULL + past expiry  → it simply lapsed
 *
 * Fire-and-forget, matching the `lastUsedAt` writes above: the request is
 * being rejected regardless, so this must not add latency to it, and a failed
 * write self-heals because the next request re-evaluates the same session.
 * `updateMany` guarded on `endedAt: null` so a racing explicit stop keeps its
 * `endedBy` rather than being clobbered by this one.
 */
function markImpersonationRevoked(db: PrismaClient, sessionId: string): void {
  db.impersonationSession
    .updateMany({ where: { id: sessionId, endedAt: null }, data: { endedAt: new Date() } })
    .catch(() => {});
}

async function resolveImpersonationJwt(
  payload: Awaited<ReturnType<typeof verifyJwt>>,
  db: PrismaClient,
): Promise<AuthContext> {
  const imp = payload.imp;
  if (!imp?.sid || !imp.act || !imp.org) return {};

  // Live session row: not ended, not expired.
  const session = await db.impersonationSession.findFirst({
    where: { id: imp.sid, endedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!session) return {};

  // Claims must match the row exactly — a token can never repoint a session
  // at a different target/org than the one audited at mint.
  //
  // #878: deliberately does NOT stamp the row ended. A token whose claims
  // disagree with the session it names has not been shown to belong to that
  // session, and a credential we are rejecting must never mutate state —
  // otherwise presenting a mismatched token would be a way to kill someone
  // else's legitimate session. (Claims are signed, so this is defence in
  // depth rather than a reachable path today.) Revocation stamping below is
  // reached only after the token is proven to belong to this session.
  if (
    session.adminUserId !== imp.act ||
    session.targetUserId !== payload.sub ||
    session.organizationId !== imp.org
  ) {
    return {};
  }

  // Both accounts must still be live. The TARGET check lives here rather than
  // in resolveJwt's generic path so it runs AFTER the claims check above and
  // can stamp the row (PR #879 review) — deleting the impersonated account
  // ends the session, it doesn't just silently stop working.
  const [target, admin] = await Promise.all([
    db.user.findFirst({ where: { id: session.targetUserId, deletedAt: null }, select: { id: true } }),
    db.user.findFirst({
      where: { id: session.adminUserId, deletedAt: null },
      select: { id: true, roles: true },
    }),
  ]);
  if (!target || !admin) {
    markImpersonationRevoked(db, session.id); // #878 — one of the parties is gone
    return {};
  }

  // Re-derive BOTH live org roles and re-apply the full peer-or-below rule on
  // every request — not just that the memberships still exist. A role change
  // after mint (target promoted to OWNER, or an OWNER actor demoted to ADMIN)
  // must invalidate the token immediately, exactly as an explicit stop does.

  const [targetMembership, adminMembership] = await Promise.all([
    db.orgMember.findFirst({
      where: { organizationId: imp.org, userId: session.targetUserId, ...LIVE_ORG_MEMBERSHIP },
      select: { role: true },
    }),
    db.orgMember.findFirst({
      where: { organizationId: imp.org, userId: session.adminUserId, ...LIVE_ORG_MEMBERSHIP },
      select: { role: true },
    }),
  ]);

  const authorized = canImpersonate({
    actorIsPlatformAdmin: admin.roles.includes('ADMIN') || admin.roles.includes('OWNER'),
    actorOrgRole: adminMembership?.role ?? null,
    targetOrgRole: targetMembership?.role ?? null,
  });
  if (!authorized) {
    // #878 — role change or lost membership: the session is over, not merely
    // failing this one request, so the audit trail should say so immediately.
    markImpersonationRevoked(db, session.id);
    return {};
  }

  return {
    clientId: `impersonation:${session.adminUserId}`,
    userId: session.targetUserId,
    // Never the target's platform roles: the impersonated context must not
    // inherit platform-admin reach, and `roles: []` also keeps every
    // isPlatformAdmin/requireRole branch inert.
    roles: [],
    impersonation: {
      sessionId: session.id,
      actorUserId: session.adminUserId,
      orgId: session.organizationId,
      expiresAt: session.expiresAt,
    },
  };
}
