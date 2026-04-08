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
  id_token?: string;
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

/**
 * Decode the email and name from the ID token (JWT).
 * Personal Microsoft accounts don't always support /me Graph endpoint,
 * so we extract profile info from the token claims instead.
 */
export function decodeIdToken(idToken: string): { email: string | null; name: string | null } {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    return {
      email: payload.email ?? payload.preferred_username ?? null,
      name: payload.name ?? null,
    };
  } catch {
    return { email: null, name: null };
  }
}

/** Fetch the signed-in user's profile from Graph API, with fallback for personal accounts. */
export async function fetchMicrosoftProfile(accessToken: string): Promise<MicrosoftProfile> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    // Personal accounts may fail on /me — return null fields, caller uses ID token instead
    return { mail: null, userPrincipalName: '', displayName: null };
  }
  return res.json() as Promise<MicrosoftProfile>;
}
