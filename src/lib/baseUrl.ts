/**
 * Base for callers that already have a localhost default. Read per call so
 * configuration changes keep the existing behavior. OAuth issuer validation
 * and callers with no default deliberately use their own resolution paths.
 *
 * Preserve raw configured bytes and legacy || semantics (including empty PORT).
 * Vite injects BASE_URL=/ in tests; only there is that sentinel treated as unset.
 * This helper does not validate or normalize an origin.
 */
export function getProjectBaseUrl(): string {
  const raw = process.env.NODE_ENV === 'test' && process.env.BASE_URL === '/'
    ? undefined
    : process.env.BASE_URL;
  return raw || `http://localhost:${process.env.PORT || 4000}`;
}
