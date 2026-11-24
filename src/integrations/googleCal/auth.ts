/**
 * Google OAuth 2.0 for GOOGLE CALENDAR CONNECTIONS — the authorize-URL side
 * only.
 *
 * Same handoff as gmail/auth.ts: the provider tool (hadrontool-google-cal)
 * owns the client secret, the code exchange, and the tokens. Core keeps
 * exactly the user-facing pieces: building the authorize URL (the client id
 * is public) and the registered redirect URI — which the tool's token
 * exchange must repeat verbatim, hence the export.
 *
 * This is a DIFFERENT OAuth client than both Sign-in-with-Google
 * (GOOGLE_CLIENT_ID, #581/#583 — login must never carry API scopes) and the
 * Gmail mailbox client (GMAIL_CLIENT_ID — its restricted-scope verification
 * must not be re-opened by adding calendar scopes). Calendar scopes are
 * Google SENSITIVE scopes (lighter verification than Gmail's restricted
 * ones, no CASA), which is exactly why they get their own client.
 */
import { getProjectBaseUrl } from '../../lib/baseUrl.js';
import { buildGoogleAuthUrl } from '../googleAuthUrl.js';

const SCOPES = [
  'openid',
  'email',
  // Without 'profile' the ID token carries no `name` claim (and userinfo
  // returns none either) — every connection's displayName would be null.
  'profile',
  // Read/write events on calendars the account can access.
  'https://www.googleapis.com/auth/calendar.events',
  // calendarList + free/busy reads (list-calendars, get-schedule).
  'https://www.googleapis.com/auth/calendar.readonly',
];

/** True when the calendar OAuth client is configured on this deploy. */
export function isGoogleCalConnectConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CAL_CLIENT_ID);
}

function getClientId(): string {
  const id = process.env.GOOGLE_CAL_CLIENT_ID;
  if (!id) throw new Error('GOOGLE_CAL_CLIENT_ID env var is required');
  return id;
}

/**
 * The registered OAuth redirect URI. Exported because the provider tool's
 * token exchange must pass the SAME value the authorize URL carried.
 */
export function getGoogleCalRedirectUri(): string {
  const base = getProjectBaseUrl();
  return `${base}/auth/google-cal/callback`;
}

/**
 * Build the URL to redirect the user to Google consent: this provider's client id, redirect URI and scopes through the shared
 * builder (#4684), which appends the optional account hint (#2948, ruling 0155) as `login_hint`, LAST. A hint only: the callback
 * still records the account Google authenticated.
 */
export function buildGoogleCalAuthUrl(state: string, loginHint?: string): string {
  return buildGoogleAuthUrl({ clientId: getClientId(), redirectUri: getGoogleCalRedirectUri(), scopes: SCOPES, state, loginHint });
}
