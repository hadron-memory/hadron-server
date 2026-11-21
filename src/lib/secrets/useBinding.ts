/** S5 (#4000): admission of the two single-value signed binding terms. */
// The capability's auth channel admits this RFC-token subset and refuses structural headers
// (hadrontool-webfetch main 35adbb16, src/ops/index.ts). Never sign a binding it cannot send.
const FORBIDDEN_AUTH_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'expect', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection']);
export function isSecretUseHeaderName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value) && !FORBIDDEN_AUTH_HEADERS.has(value.toLowerCase());
}

/** Reject, never normalize, an HTTPS origin and path with no embedded credential or ambiguous slash. */
export function isSecretUsePrefix(value: unknown): value is string {
  if (typeof value !== 'string' || value === '*' || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      !/%(?:2f|5c)/i.test(url.pathname) && value === url.href;
  } catch { return false; }
}
