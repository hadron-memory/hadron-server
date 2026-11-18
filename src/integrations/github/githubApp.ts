import { createPrivateKey } from 'crypto';
import { SignJWT, importPKCS8 } from 'jose';

const GITHUB_API = 'https://api.github.com';

/** The App identity used to sign the installation-token request. */
export interface GithubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

/**
 * Resolve the App credentials (explicit per-org, else env) and sign the
 * short-lived App JWT that authorizes an installation-token request.
 */
async function signAppJwt(credentials?: GithubAppCredentials): Promise<string> {
  const appId = credentials?.appId ?? process.env.GITHUB_APP_ID;
  const privateKeyPem = credentials?.privateKeyPem ?? process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKeyPem) {
    throw new Error('GitHub App credentials are not configured for this organization');
  }

  // GitHub App JWTs must be signed with RS256
  // GitHub generates PKCS#1 (RSA PRIVATE KEY) but jose needs PKCS#8 — normalize via Node crypto
  const pem = privateKeyPem.replace(/\\n/g, '\n');
  const pkcs8Pem = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }) as string;
  const privateKey = await importPKCS8(pkcs8Pem, 'RS256');

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 30) // allow 30s clock skew
    .setExpirationTime(now + 540) // 9 minutes (under GitHub's 10-min max)
    .setIssuer(appId)
    .sign(privateKey);
}

function postAccessTokens(installationId: number, jwt: string, body?: unknown): Promise<Response> {
  return fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Exchange a GitHub App installation ID for a short-lived access token.
 *
 * Credentials can be provided explicitly (per-org SaaS model) or fall back
 * to env vars GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY.
 *
 * The returned token is valid for ~1 hour and can be used as HTTPS clone
 * credentials: https://x-access-token:<token>@github.com/owner/repo.git
 *
 * It carries EVERY permission the installation holds (contents-write
 * included): this is the sync/push credential, and it must never reach a
 * model-driven run. Runs use `mintScopedInstallationToken` (#2485).
 */
export async function getInstallationToken(
  installationId: number,
  credentials?: GithubAppCredentials,
): Promise<string> {
  const jwt = await signAppJwt(credentials);
  const res = await postAccessTokens(installationId, jwt);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Why a scoped mint did not produce a usable token (#2485). */
export type ScopedMintFailure = 'NOT_CONFIGURED' | 'REFUSED' | 'SCOPE_MISMATCH' | 'UNAVAILABLE';

/**
 * Thrown by `mintScopedInstallationToken`. Carries a reason and the HTTP
 * status only: never GitHub's response body, never the token.
 */
export class ScopedMintError extends Error {
  constructor(
    readonly reason: ScopedMintFailure,
    readonly status?: number,
  ) {
    super(`GitHub scoped token mint failed (${reason}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'ScopedMintError';
  }
}

/**
 * Mint an installation token narrowed to one repository and exactly
 * `permissions` (#2485, epic #2435 slice C).
 *
 * Same App, same installation as the sync credential, narrowed per call:
 * Holger ruled that this is "the existing integration", not a new GitHub
 * credential (hadron-server#2485, comment 6432580535). GitHub only grants a
 * subset of what the installation holds, so an installation that has not
 * accepted a permission refuses the mint (REFUSED).
 *
 * The grant GitHub reports back is checked too: a token whose `permissions`
 * differ from the request in any key or level is discarded unused
 * (SCOPE_MISMATCH), so a wider credential can never leave this function.
 * So is one whose `repositories` is not exactly `owner/name`: the request
 * can only name the repository, which GitHub resolves inside the
 * installation's own account, so a different owner shows up here.
 * The token is returned to the caller only; callers must not cache, log or
 * return it.
 */
export async function mintScopedInstallationToken(
  installationId: number,
  credentials: GithubAppCredentials | undefined,
  scope: { repository: { owner: string; name: string }; permissions: Record<string, 'read'> },
): Promise<string> {
  let jwt: string;
  try {
    jwt = await signAppJwt(credentials);
  } catch {
    throw new ScopedMintError('NOT_CONFIGURED');
  }
  let res: Response;
  try {
    res = await postAccessTokens(installationId, jwt, {
      repositories: [scope.repository.name],
      permissions: scope.permissions,
    });
  } catch {
    throw new ScopedMintError('UNAVAILABLE');
  }
  if (!res.ok) {
    // 403/404/422: the installation cannot grant this repository or
    // permission set. Anything else is GitHub being unavailable.
    const refused = res.status === 403 || res.status === 404 || res.status === 422;
    throw new ScopedMintError(refused ? 'REFUSED' : 'UNAVAILABLE', res.status);
  }
  let data: { token?: unknown; permissions?: unknown; repositories?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new ScopedMintError('UNAVAILABLE', res.status);
  }
  if (
    typeof data.token !== 'string' ||
    !sameGrant(data.permissions, scope.permissions) ||
    !sameRepository(data.repositories, scope.repository)
  ) {
    throw new ScopedMintError('SCOPE_MISMATCH');
  }
  return data.token;
}

/** True when GitHub's reported grant is exactly the requested one. */
function sameGrant(granted: unknown, requested: Record<string, string>): boolean {
  if (!granted || typeof granted !== 'object' || Array.isArray(granted)) return false;
  const g = granted as Record<string, unknown>;
  const keys = Object.keys(g);
  if (keys.length !== Object.keys(requested).length) return false;
  return keys.every((k) => requested[k] === g[k]);
}

/** True when GitHub's reported repositories are exactly `owner/name`, ignoring case. */
function sameRepository(granted: unknown, requested: { owner: string; name: string }): boolean {
  if (!Array.isArray(granted) || granted.length !== 1) return false;
  const fullName = (granted[0] as { full_name?: unknown } | null)?.full_name;
  return (
    typeof fullName === 'string' &&
    fullName.toLowerCase() === `${requested.owner}/${requested.name}`.toLowerCase()
  );
}

/**
 * Convert a git URL (SSH or HTTPS) to an HTTPS URL with an embedded access token.
 *
 * "git@github.com:owner/repo.git"
 *   → "https://x-access-token:<token>@github.com/owner/repo.git"
 *
 * "https://github.com/owner/repo.git"
 *   → "https://x-access-token:<token>@github.com/owner/repo.git"
 */
export function toHttpsUrl(gitUrl: string, token: string): string {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = gitUrl.match(/^git@github\.com:(.+)$/);
  if (sshMatch) {
    return `https://x-access-token:${token}@github.com/${sshMatch[1]}`;
  }

  // HTTPS format: https://github.com/owner/repo.git
  return gitUrl.replace(/^https:\/\/github\.com\//, `https://x-access-token:${token}@github.com/`);
}
