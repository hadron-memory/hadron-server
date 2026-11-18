/**
 * Microsoft OAuth 2.0 — the AUTHORIZE-URL side only.
 *
 * #396: the provider tool (hadrontool-ms-exchange) owns the client secret,
 * the code exchange, and the tokens. Core keeps exactly the user-facing
 * pieces: building the authorize URL (the client id is public) and the
 * registered redirect URI — which the tool's token exchange must repeat
 * verbatim, hence the export.
 *
 * Hadron owns ONE multi-tenant Azure AD app. Users sign in with their
 * Microsoft account — no Azure Portal visit needed.
 */
import { getProjectBaseUrl } from '../../lib/baseUrl.js';

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

/**
 * The registered OAuth redirect URI. Exported because the provider tool's
 * token exchange must pass the SAME value the authorize URL carried.
 */
export function getMicrosoftRedirectUri(): string {
  const base = getProjectBaseUrl();
  return `${base}/auth/microsoft/callback`;
}

/** Build the URL to redirect the user to Microsoft login. */
export function buildMicrosoftAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: getMicrosoftRedirectUri(),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent',       // always show consent so user sees the permissions
  });
  return `${AUTHORITY}/authorize?${params.toString()}`;
}
