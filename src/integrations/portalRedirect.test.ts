import { describe, it, expect } from 'vitest';
import { isPortalPath, portalPathOrRoot } from './portalRedirect.js';

const FRONTEND = 'https://portal.example';

describe('isPortalPath (#2909)', () => {
  it.each(['/', '/app/dashboard', '/app/dashboard?x=1#h', '/%5Cevil.example', '/a//b'])('accepts %s', (v) => {
    expect(isPortalPath(v, FRONTEND)).toBe(true);
  });

  it.each(['', '//h', '/\\h', '\\h', 'h/x', 'https://h', 'javascript:alert(1)', '\t//h', '/\t/h', '/a b', '/a\u0000b', ' /a', '/..//evil', '/.//evil', '/%2e%2e//evil', '/a/..//evil'])(
    'refuses %j',
    (v) => {
      expect(isPortalPath(v, FRONTEND)).toBe(false);
    },
  );

  it('refuses a non-string', () => {
    expect(isPortalPath(undefined, FRONTEND)).toBe(false);
    expect(isPortalPath(42, FRONTEND)).toBe(false);
  });

  it('fails closed when the portal origin cannot be resolved (the origin comparison is its own guard)', () => {
    expect(isPortalPath('/app/dashboard', 'not a url')).toBe(false);
  });
});

describe('portalPathOrRoot', () => {
  it('keeps a portal path and sends anything else to /', () => {
    expect(portalPathOrRoot('/app/x', FRONTEND)).toBe('/app/x');
    expect(portalPathOrRoot('https://evil.example', FRONTEND)).toBe('/');
  });
});
