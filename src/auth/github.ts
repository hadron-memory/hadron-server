export interface GitHubUser {
  id: number;         // GitHub numeric ID
  login: string;
  name: string | null;
  avatar_url: string;
}

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_APP_CLIENT_ID!,
    redirect_uri: process.env.GITHUB_OAUTH_APP_AUTH_CALLBACK_URL ?? getCallbackUrl(),
    scope: 'read:user',
    state,
  });
  return `${GITHUB_AUTH_URL}?${params}`;
}

export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_APP_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_APP_CLIENT_SECRET,
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub OAuth error: ${data.error ?? 'no access_token'}`);
  }
  return data.access_token;
}

export async function fetchUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json() as Promise<GitHubUser>;
}

export async function checkOrgMembership(
  accessToken: string,
  org: string,
): Promise<boolean> {
  const res = await fetch(`${GITHUB_API}/user/orgs`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false;
  const orgs = (await res.json()) as Array<{ login: string }>;
  return orgs.some((o) => o.login.toLowerCase() === org.toLowerCase());
}

function getCallbackUrl(): string {
  // `||` (not `??`) so empty-string BASE_URL / PORT — e.g. shell `BASE_URL= node ...`
  // or `vi.stubEnv('PORT', '')` — fall back instead of producing `http://localhost:`.
  // Symmetric with src/mcp/server.ts:getDeploymentInfo and src/auth/email.ts.
  // Centralization across the four `BASE_URL` consumers is a known follow-up
  // (see src/auth/oauth.ts docstring + CLAUDE.md BASE_URL row).
  const base =
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  return `${base}/auth/github/callback`;
}
