import { createPrivateKey } from 'crypto';
import { SignJWT, importPKCS8 } from 'jose';

const GITHUB_API = 'https://api.github.com';

/**
 * Exchange a GitHub App installation ID for a short-lived access token.
 *
 * Credentials can be provided explicitly (per-org SaaS model) or fall back
 * to env vars GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY.
 *
 * The returned token is valid for ~1 hour and can be used as HTTPS clone
 * credentials: https://x-access-token:<token>@github.com/owner/repo.git
 */
export async function getInstallationToken(
  installationId: number,
  credentials?: { appId: string; privateKeyPem: string },
): Promise<string> {
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
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60) // allow 60s clock skew
    .setExpirationTime(now + 600) // 10 minutes (GitHub max)
    .setIssuer(appId)
    .sign(privateKey);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
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
