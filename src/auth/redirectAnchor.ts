/**
 * #2626 — the second identity anchor on the OAuth prompt and consent pages.
 *
 * `clientName` is registered by the client itself, so it proves nothing. The
 * registered redirect destination is shown beneath it as opaque text. The
 * input is ONLY the already-validated registered redirect URI, never Host,
 * `resource` or query text, and the result is only ever substituted through
 * `renderTemplate` (escaped), never as a link, form value or redirect operand.
 *
 *   web (http/https)            host, plus the port only when non-default
 *   custom scheme + authority   scheme://host
 *   custom scheme, no authority scheme only
 *
 * Userinfo, path, query and fragment are never shown.
 */
export function redirectAnchor(registeredRedirectUri: string): string {
  let url: URL;
  try {
    url = new URL(registeredRedirectUri);
  } catch {
    return 'unknown destination';
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return url.host === '' ? 'unknown destination' : url.host;
  }
  return url.hostname === '' ? scheme : `${scheme}://${url.hostname}`;
}
