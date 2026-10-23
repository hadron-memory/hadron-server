import { getProjectBaseUrl } from '../../lib/baseUrl.js';
/**
 * Google OAuth 2.0 for GOOGLE DRIVE CONNECTIONS — the authorize-URL side
 * only.
 *
 * Same handoff as gmail/auth.ts and googleCal/auth.ts: the provider tool
 * (hadrontool-google-drive) owns the client secret, the code exchange, and
 * the tokens. Core keeps exactly the user-facing pieces: building the
 * authorize URL (the client id is public) and the registered redirect URI —
 * which the tool's token exchange must repeat verbatim, hence the export.
 *
 * This is a DIFFERENT OAuth client than Sign-in-with-Google
 * (GOOGLE_CLIENT_ID, #581/#583 — login must never carry API scopes), the
 * Gmail mailbox client (GMAIL_CLIENT_ID), and the Calendar client
 * (GOOGLE_CAL_CLIENT_ID). `drive.readonly` is a RESTRICTED scope
 * (Gmail-tier CASA verification — #750 tracks the assessment and the
 * possible shared-client-with-Gmail decision); adding it to any existing
 * client would re-open that client's verification.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = [
  'openid',
  'email',
  // Without 'profile' the ID token carries no `name` claim (and userinfo
  // returns none either) — every connection's displayName would be null.
  'profile',
  // Read ALL of the user's files — the ingestion decision (#749): Drive is
  // an "import my GDocs" channel, so drive.file-only reads don't suffice.
  // RESTRICTED scope.
  'https://www.googleapis.com/auth/drive.readonly',
  // Write ONLY to files this app created — which enforces the product
  // boundary "create new docs, never edit existing" at the API level.
  'https://www.googleapis.com/auth/drive.file',
];

/** True when the Drive OAuth client is configured on this deploy. */
export function isGoogleDriveConnectConfigured(): boolean {
  return Boolean(process.env.GOOGLE_DRIVE_CLIENT_ID);
}

function getClientId(): string {
  const id = process.env.GOOGLE_DRIVE_CLIENT_ID;
  if (!id) throw new Error('GOOGLE_DRIVE_CLIENT_ID env var is required');
  return id;
}

/**
 * The registered OAuth redirect URI. Exported because the provider tool's
 * token exchange must pass the SAME value the authorize URL carried.
 */
export function getGoogleDriveRedirectUri(): string {
  const base = getProjectBaseUrl();
  return `${base}/auth/google-drive/callback`;
}

/** Build the URL to redirect the user to Google consent. */
export function buildGoogleDriveAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: getGoogleDriveRedirectUri(),
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
