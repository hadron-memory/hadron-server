/**
 * Microsoft OAuth 2.0 Authorization Code flow (delegated permissions).
 *
 * Hadron owns ONE multi-tenant Azure AD app. Users sign in with their
 * Microsoft account — no Azure Portal visit needed.
 */

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',          // refresh token
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.Read',
];

function getClientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID;
  if (!id) throw new Error('MICROSOFT_CLIENT_ID env var is required');
  return id;
}

function getClientSecret(): string {
  const secret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!secret) throw new Error('MICROSOFT_CLIENT_SECRET env var is required');
  return secret;
}

function getRedirectUri(): string {
  const base = process.env.BASE_URL || 'http://localhost:4000';
  return `${base}/auth/microsoft/callback`;
}

/** Build the URL to redirect the user to Microsoft login. */
export function buildMicrosoftAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent',       // always show consent so user sees the permissions
  });
  return `${AUTHORITY}/authorize?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Exchange the authorization code for tokens. */
export async function exchangeMicrosoftCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    code,
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
    scope: SCOPES.join(' '),
  });

  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft token exchange failed: ${err}`);
  }

  return res.json() as Promise<TokenResponse>;
}

/** Use a refresh token to get a fresh access token. */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES.join(' '),
  });

  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft token refresh failed: ${err}`);
  }

  return res.json() as Promise<TokenResponse>;
}

export interface MicrosoftProfile {
  mail: string | null;
  userPrincipalName: string;
  displayName: string | null;
}

/** Fetch the signed-in user's profile from Graph API. */
export async function fetchMicrosoftProfile(accessToken: string): Promise<MicrosoftProfile> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to fetch Microsoft profile: ${err}`);
  }
  return res.json() as Promise<MicrosoftProfile>;
}
