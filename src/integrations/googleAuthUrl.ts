/**
 * #4684: the one Google OAuth authorize-URL builder behind the three mailbox-connect providers (gmail, google-cal, google-drive).
 * Each provider keeps its OWN client id, redirect URI and scopes (they are different OAuth clients, deliberately not merged:
 * see gmail/auth.ts) and passes them in; nothing here defaults one provider's value for another's.
 *
 * The parameter order is fixed: client_id, response_type, redirect_uri, scope, state, access_type, prompt, and then, only when a
 * hint is given, login_hint (#2948, rulings 0155 and 0156), so a hint-less URL is byte-identical to the pre-#2948 one. The hint
 * is only a hint: the callback still records the account Google actually authenticated. Pinned per provider by
 * googleProviderAuthUrls4684.test.ts.
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export function buildGoogleAuthUrl(a: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: a.clientId,
    response_type: 'code',
    redirect_uri: a.redirectUri,
    scope: a.scopes.join(' '),
    state: a.state,
    // Both are load-bearing: without offline+consent Google returns NO
    // refresh token and the tool's /connections call fails with a typed
    // validation_error.
    access_type: 'offline',
    prompt: 'consent',
  });
  if (a.loginHint !== undefined) params.set('login_hint', a.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}
