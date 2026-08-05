/**
 * #881 — the portal-link builder behind the `URL:` line on node reads.
 *
 * What this file pins:
 *   - the link SHAPE (`<origin>/app/u/<urn>`, URN kept raw) — the portal's
 *     URN-resolver route, so an agent never assembles a URL itself;
 *   - that an unconfigured or malformed `FRONTEND_URL` yields `null`, i.e. NO
 *     link rather than one pointing at the wrong host (the issue's explicit
 *     requirement: a wrong-host URL is worse than none).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getPortalBaseUrl, portalUrlForUrn } from './portalUrl.js';

const URN = 'hrn:node:micromentor.org:mmdata:services:academy-active-courses';

function setBase(value: string | undefined) {
  if (value === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = value;
}

afterEach(() => {
  delete process.env.FRONTEND_URL;
  vi.restoreAllMocks();
});

describe('getPortalBaseUrl', () => {
  it('returns the configured origin', () => {
    setBase('https://hadronmemory.com');
    expect(getPortalBaseUrl()).toBe('https://hadronmemory.com');
  });

  it('strips trailing slashes and surrounding whitespace', () => {
    setBase('  https://hadronmemory.com//  ');
    expect(getPortalBaseUrl()).toBe('https://hadronmemory.com');
  });

  it('keeps an explicit port and a subpath mount', () => {
    setBase('http://localhost:5173');
    expect(getPortalBaseUrl()).toBe('http://localhost:5173');
    setBase('https://example.com/portal/');
    expect(getPortalBaseUrl()).toBe('https://example.com/portal');
  });

  it('returns null when unset or blank', () => {
    setBase(undefined);
    expect(getPortalBaseUrl()).toBeNull();
    setBase('   ');
    expect(getPortalBaseUrl()).toBeNull();
  });

  it('keeps an IPv6 host with a port', () => {
    setBase('http://[::1]:4000');
    expect(getPortalBaseUrl()).toBe('http://[::1]:4000');
  });

  it.each([
    ['no scheme', 'hadronmemory.com'],
    ['non-http scheme', 'ftp://hadronmemory.com'],
    ['carries a query', 'https://hadronmemory.com/?a=1'],
    ['carries a fragment', 'https://hadronmemory.com/#x'],
    ['embedded whitespace', 'https://hadron memory.com'],
    // PR #886 review (Codex P2): a shape regex that only bans delimiters
    // accepts these and emits an unusable href. Parsing rejects them.
    ['unparseable authority', 'https://%'],
    ['non-numeric port', 'https://hadronmemory.com:abc'],
    ['no host at all', 'https://'],
    ['embedded credentials', 'https://user:pw@hadronmemory.com'],
  ])('returns null for a malformed base URL (%s)', (_label, value) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBase(value);
    expect(getPortalBaseUrl()).toBeNull();
  });
});

describe('portalUrlForUrn', () => {
  it('builds the /app/u/<urn> resolver link with the URN kept raw', () => {
    setBase('https://hadronmemory.com');
    expect(portalUrlForUrn(URN)).toBe(`https://hadronmemory.com/app/u/${URN}`);
    // Colons are NOT percent-encoded — the route is a single path segment and
    // the portal's own copy-link button emits them raw.
    expect(portalUrlForUrn(URN)).toContain(':mmdata:services:');
    expect(portalUrlForUrn(URN)).not.toContain('%3A');
  });

  it('is null when no portal origin is configured', () => {
    setBase(undefined);
    expect(portalUrlForUrn(URN)).toBeNull();
  });

  it('is null for an empty URN', () => {
    setBase('https://hadronmemory.com');
    expect(portalUrlForUrn('   ')).toBeNull();
  });
});
