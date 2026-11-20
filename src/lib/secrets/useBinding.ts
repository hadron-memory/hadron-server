/** S5 (#4000): admission of the two single-value signed binding terms. */
export function isSecretUseHeaderName(value: unknown): value is string {
  return typeof value === 'string' && value !== '*' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
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
