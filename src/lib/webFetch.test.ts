/**
 * #457 — egress-policy unit tests for the importNode url path. The address
 * classifier is tested against the classic SSRF bypass shapes; the fetch
 * loop itself is exercised through the resolver tests with the module
 * mocked (no network in CI).
 */

import { describe, it, expect } from 'vitest';
import { isForbiddenAddress, parseImportUrl } from './webFetch.js';

describe('isForbiddenAddress', () => {
  it('blocks the private/reserved IPv4 ranges', () => {
    for (const ip of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1', // CGNAT
      '100.127.255.254',
      '127.0.0.1',
      '127.8.9.10',
      '169.254.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it('blocks loopback/unspecified/ULA/link-local/multicast IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it('unwraps IPv4-mapped IPv6 and applies the IPv4 rules', () => {
    expect(isForbiddenAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isForbiddenAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('treats non-IP input as forbidden (defense in depth)', () => {
    expect(isForbiddenAddress('localhost')).toBe(true);
    expect(isForbiddenAddress('')).toBe(true);
  });
});

describe('parseImportUrl', () => {
  it('accepts http and https', () => {
    expect(parseImportUrl('https://example.com/page').hostname).toBe('example.com');
    expect(parseImportUrl('http://example.com').protocol).toBe('http:');
  });

  it('rejects other schemes with IMPORT_URL_INVALID', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'gopher://x', 'javascript:alert(1)']) {
      try {
        parseImportUrl(bad);
        expect.unreachable(`accepted ${bad}`);
      } catch (e) {
        expect((e as { extensions?: { code?: string } }).extensions?.code).toBe('IMPORT_URL_INVALID');
      }
    }
  });

  it('rejects malformed and oversized URLs', () => {
    for (const bad of ['not a url', `https://example.com/${'x'.repeat(2100)}`]) {
      try {
        parseImportUrl(bad);
        expect.unreachable('accepted');
      } catch (e) {
        expect((e as { extensions?: { code?: string } }).extensions?.code).toBe('IMPORT_URL_INVALID');
      }
    }
  });
});
