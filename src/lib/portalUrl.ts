/**
 * Portal deep links for URN-addressed resources (#881).
 *
 * Node reads carry a ready-made portal URL so an agent never has to
 * *construct* one. Constructing means guessing which URN spelling the portal's
 * `/app/u/<urn>` route resolves, and the guess is easy to get wrong: the tools
 * accept the legacy `::` forms, project instructions and Hadron nodes are
 * written in them, but the route resolves the canonical v2 form. An agent that
 * assembles a link out of what it has been reading all session produces a
 * plausible URL that 404s — or an `hrn:`-scheme href, which renders as a link
 * and resolves to nothing at all, so neither side gets a failure signal.
 *
 * ## Why the URN form and not a primary-key deep link
 *
 * The emitted shape is `<portal-origin>/app/u/<urn>` — the portal's URN
 * resolver route (hadron-portal#262), which 307-redirects to the resource's
 * canonical PK page. Deliberately the URN form:
 *
 *   - it is the link shape this project already tells contributors to hand a
 *     human (`CLAUDE.md`: "link `https://hadronmemory.com/app/u/<URN>`"), and
 *     the one the portal's own "Copy URL" button emits — one shape platform-wide;
 *   - it is the same URN the read projection prints one line above, so the link
 *     and the printed identifier cannot disagree about what they address;
 *   - the PK page path is the part hadron-portal#262 reserves the right to
 *     change — that is why its redirect is 307 and not 308. The alias is the
 *     stable surface; a PK path baked into server output is not.
 *
 * A node's immutable primary key stays on the adjacent `ID:` line, for callers
 * that need a reference which survives a move (a URN carries the node's `loc`,
 * and `hadron_move_node` changes it).
 *
 * ## Base URL
 *
 * Derived from `FRONTEND_URL` (the portal origin — already the CORS origin and
 * OAuth redirect base), never hardcoded: self-hosted and non-production
 * instances exist, and a URL pointing at the wrong host is worse than no URL.
 * When it is unset or malformed, callers omit the line entirely rather than
 * emit a link to `localhost` from a deployed server.
 */

/** Warn once per process — this is a static misconfiguration, not per-request news. */
let warnedMalformed = false;

function rejectMalformed(raw: string): null {
  if (!warnedMalformed) {
    warnedMalformed = true;
    console.warn(
      `[portalUrl] FRONTEND_URL is not a usable base URL ("${raw}") — ` +
        'portal links will be omitted from node reads. Expected <scheme>://<host>[:<port>][/<path>], ' +
        'http(s) only, no credentials, query or fragment.',
    );
  }
  return null;
}

/**
 * The portal origin to build user-facing links against, trailing slashes
 * stripped, or `null` when it isn't configured (or isn't a usable base URL).
 * `null` means "emit no link" — see the module docstring.
 *
 * Validated by PARSING (`new URL`), not by a shape regex: a regex that merely
 * bans delimiters still accepts an unusable authority — `https://%`,
 * `https://host:abc` — and would emit a broken href, which is exactly the
 * outcome this contract exists to prevent (PR #886 review, Codex P2). The
 * returned value is rebuilt from the parsed origin + path, so nothing that
 * survives parsing can smuggle an odd form into an emitted link.
 */
export function getPortalBaseUrl(): string | null {
  const raw = process.env.FRONTEND_URL?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return rejectMalformed(raw);
  }
  // http(s) only (a `file:`/`ftp:` base is never a portal); no credentials
  // (they'd be copied into every emitted link); no query or fragment (a base
  // URL carrying either is a misconfiguration, and appending a path to it
  // would produce nonsense).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rejectMalformed(raw);
  if (parsed.username || parsed.password) return rejectMalformed(raw);
  if (parsed.search || parsed.hash) return rejectMalformed(raw);
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * The portal URL that opens `urn`, or `null` when no portal origin is
 * configured. The URN is kept raw, not percent-encoded: the grammar only
 * produces `:` delimiters plus slug atoms, and the resolver route is a single
 * path segment, so escaping the colons would only make the link harder to read
 * (matching the portal's own `buildResolverUrl`).
 */
export function portalUrlForUrn(urn: string): string | null {
  const base = getPortalBaseUrl();
  if (!base) return null;
  const trimmed = urn.trim();
  if (!trimmed) return null;
  return `${base}/app/u/${trimmed}`;
}
