/**
 * Google OAuth 2.0 for GMAIL MAILBOX CONNECTIONS — the authorize-URL side
 * only.
 *
 * #580: the provider tool (hadrontool-gmail) owns the client secret, the
 * code exchange, and the tokens. Core keeps exactly the user-facing pieces:
 * building the authorize URL (the client id is public) and the registered
 * redirect URI — which the tool's token exchange must repeat verbatim,
 * hence the export.
 *
 * This is a DIFFERENT OAuth client in a DIFFERENT GCP project than
 * Sign-in-with-Google (src/auth/google.ts, GOOGLE_CLIENT_ID): gmail.modify /
 * gmail.send are restricted scopes, and sharing a client would drag login
 * into restricted-scope verification (#581/#583). Never merge the two.
 */
import { getProjectBaseUrl } from '../../lib/baseUrl.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = [
  'openid',
  'email',
  // Without 'profile' the ID token carries no `name` claim (and userinfo
  // returns none either) — every connection's displayName would be null.
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

/** True when the Gmail mailbox OAuth client is configured on this deploy. */
export function isGmailConnectConfigured(): boolean {
  return Boolean(process.env.GMAIL_CLIENT_ID);
}

function getClientId(): string {
  const id = process.env.GMAIL_CLIENT_ID;
  if (!id) throw new Error('GMAIL_CLIENT_ID env var is required');
  return id;
}

/**
 * The registered OAuth redirect URI. Exported because the provider tool's
 * token exchange must pass the SAME value the authorize URL carried.
 */
export function getGmailRedirectUri(): string {
  const base = getProjectBaseUrl();
  return `${base}/auth/gmail/callback`;
}

/** Build the URL to redirect the user to Google consent. */
export function buildGmailAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: getGmailRedirectUri(),
    scope: SCOPES.join(' '),
    state,
    // Both are load-bearing: without offline+consent Google returns NO
    // refresh token and the tool's /connections call fails with a typed
    // validation_error.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}
