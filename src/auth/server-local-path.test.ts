import { describe, it, expect } from 'vitest';
import { isServerLocalPath } from './server-local-path.js';

describe('isServerLocalPath', () => {
  // ── Accepted shapes ───────────────────────────────────────────────

  it.each([
    '/',                              // root
    '/app/setup',
    '/oauth/authorize',
    '/oauth/authorize?state=abc&code_challenge=xyz',
    '/path/with/multiple/segments',
    '/foo:bar',                       // colon in path is fine; only protocol-prefix matters
    '/foo://bar',                     // ://-in-path is also fine — only the LEADING scheme triggers protocol detection (PR #149 review)
    '/with%20encoded%20chars',
    '/api/v1/resources/123',
    '/x?return_to=/y',                // nested query params with paths are OK
  ])('accepts %j', (value) => {
    expect(isServerLocalPath(value)).toBe(true);
  });

  // ── Rejected: open-redirect to external origin ────────────────────

  it.each([
    'https://evil.example/grab-cookie',
    'http://evil.example/',
    'https://hadronmemory.com/',      // even our own domain over absolute URL is rejected — we want explicit server-local
    'ftp://files.example.com',
  ])('rejects absolute URL %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Rejected: protocol-relative ───────────────────────────────────

  it.each([
    '//evil.example',
    '//evil.example/grab-cookie',
    '//cdn.evil.example/x.js',
  ])('rejects protocol-relative URL %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Rejected: backslash-normalization tricks ──────────────────────

  it.each([
    '/\\evil.example',                // second char backslash → browser normalizes to //evil.example
    '/\\\\evil.example',
    '/foo\\bar',                      // any backslash in the path
    '/path\\with\\backslashes',
  ])('rejects backslash-containing %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Rejected: protocol-injection schemes ──────────────────────────

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:alert(1)',
  ])('rejects protocol-injection %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Rejected: control-byte injection (CRLF, NUL, etc.) ────────────

  it.each([
    '/foo\nbar',                      // LF — could break res.redirect()'s Location header
    '/foo\rbar',                      // CR — same
    '/foo\r\nLocation: //evil.example', // explicit CRLF injection attempt
    '/foo\x00bar',                    // NUL
    '/foo\tbar',                      // TAB
    '/foo\x7Fbar',                    // DEL (\x7F)
    '/\x01foo',                       // SOH at second char
  ])('rejects control-byte injection %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Rejected: misc malformed ──────────────────────────────────────

  it.each([
    '',                               // empty string
    'no-leading-slash',
    'foo/bar',
    ' /leading-space',                // leading whitespace before /
  ])('rejects malformed %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Rejected: non-string input ────────────────────────────────────

  it.each([
    [undefined],
    [null],
    [123],
    [true],
    [{}],
    [[]],
    [['/path']],                      // arrays of strings are still rejected — Express can give arrays for repeated query params
  ])('rejects non-string input %j', (value) => {
    expect(isServerLocalPath(value)).toBe(false);
  });

  // ── Edge cases worth pinning ──────────────────────────────────────

  it('accepts a bare slash (root path)', () => {
    expect(isServerLocalPath('/')).toBe(true);
  });

  it('rejects a triple slash (could be parsed as //relative)', () => {
    // First char '/', second char '/' → caught by the protocol-
    // relative check at char[1].
    expect(isServerLocalPath('///evil.example')).toBe(false);
  });

  it('narrows to string at the type level via the type guard', () => {
    const value: unknown = '/app/setup';
    if (isServerLocalPath(value)) {
      // Inside this branch TS sees `value` as `string`.
      const upper: string = value.toUpperCase();
      expect(upper).toBe('/APP/SETUP');
    } else {
      throw new Error('predicate should have accepted /app/setup');
    }
  });
});
