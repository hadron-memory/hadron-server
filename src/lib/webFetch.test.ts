/**
 * #457 — egress-policy unit tests for the importNode url path. The address
 * classifier is tested against the classic SSRF bypass shapes; the fetch
 * loop itself is exercised through the resolver tests with the module
 * mocked (no network in CI).
 */

import { describe, it, expect } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { isForbiddenAddress, embeddedIpv4, parseImportUrl, pinnedLookup } from './webFetch.js';

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

  it('blocks loopback/unspecified/ULA/link-local/site-local/multicast IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'feff::1', 'ff02::1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it('blocks the rest of the IANA special-purpose ranges, compared numerically (#1380 review)', () => {
    for (const ip of [
      '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.254', '198.51.100.7', '203.0.113.9',
      '64:ff9b:1::1', '100::1', '2001::1', '2001:1ff::1', '2001:db8::1', '2001:0db8:0000::1', '2002:c000:0204::1',
      '3fff::1', '5f00::1', '4000::1', 'fc::1', '1::1', 'e000::1', '64:ff9b::a00:1', '64:ff9b::127.0.0.1', '::ffff:0:a00:1', '::ffff:0:10.0.0.1', '::ffff:0:a9fe:a9fe', 'not-an-ip:zz::1',
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    // Neighbours stay public, and NAT64 to a PUBLIC IPv4 is how an IPv6-only
    // host reaches one.
    for (const ip of ['192.0.1.1', '192.0.3.1', '198.17.255.255', '198.20.0.1', '203.0.114.1', '2001:200::1', '2001:4860:4860::8888', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '::ffff:0:808:808']) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it('unwraps IPv4-mapped IPv6 (dotted AND hex forms) and applies the IPv4 rules', () => {
    // Dotted shape.
    expect(isForbiddenAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false);
    // Hex shape — the bypass Codex/Gemini flagged (PR-486): the OS treats
    // these identically to the dotted form.
    expect(isForbiddenAddress('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isForbiddenAddress('::ffff:7f00:0001')).toBe(true); // leading zeros
    expect(isForbiddenAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isForbiddenAddress('::ffff:0a00:0001')).toBe(true); // 10.0.0.1
    expect(isForbiddenAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
    // Deprecated IPv4-compatible form (::/96) — also unwrapped.
    expect(isForbiddenAddress('::7f00:1')).toBe(true); // 127.0.0.1
    expect(isForbiddenAddress('::127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::808:808')).toBe(false); // 8.8.8.8
  });

  it('embeddedIpv4 extracts from both textual shapes and ignores plain IPv6', () => {
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(embeddedIpv4('::a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('2606:4700:4700::1111')).toBeNull();
    expect(embeddedIpv4('::1')).toBeNull(); // plain loopback, not embedded v4
    expect(embeddedIpv4('::')).toBeNull();
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

describe('pinnedLookup — DNS-rebinding pin (#645)', () => {
  const call = (
    addrs: LookupAddress[],
    options: { all?: boolean; family?: number },
  ): Promise<{ address: unknown; family?: number }> =>
    new Promise((resolve, reject) => {
      pinnedLookup(addrs)('rebind.example', options, (err, address, family) =>
        err ? reject(err) : resolve({ address, family }),
      );
    });

  it('hands back the whole validated set for an all=true query (no re-resolution)', async () => {
    const addrs: LookupAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    expect((await call(addrs, { all: true })).address).toEqual(addrs);
  });

  it('hands back the first address+family for a single query', async () => {
    expect(await call([{ address: '93.184.216.34', family: 4 }], { all: false })).toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('refuses to return a forbidden address even if one slips into the pin set', async () => {
    await expect(call([{ address: '127.0.0.1', family: 4 }], { all: false })).rejects.toThrow(
      /re-validation/,
    );
  });

  it('errors on an empty pin set instead of indexing undefined', async () => {
    await expect(call([], { all: true })).rejects.toThrow(/no pinned addresses/);
  });

  it('honors an explicitly requested family for a single query', async () => {
    const addrs: LookupAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    expect(await call(addrs, { all: false, family: 6 })).toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });

  it('errors when no pinned address matches the requested family', async () => {
    await expect(
      call([{ address: '93.184.216.34', family: 4 }], { all: false, family: 6 }),
    ).rejects.toThrow(/family 6/);
  });

  it('honors a bare numeric family argument (Node lookup(host, 4, cb) form)', async () => {
    const addrs: LookupAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    // dns.lookup allows `options` to be a family integer instead of an object.
    const res: { address: unknown; family?: number } = await new Promise((resolve, reject) => {
      (pinnedLookup(addrs) as unknown as (
        h: string,
        o: number,
        cb: (e: Error | null, a?: unknown, f?: number) => void,
      ) => void)('rebind.example', 6, (err, address, family) =>
        err ? reject(err) : resolve({ address, family }),
      );
    });
    expect(res).toEqual({ address: '2606:4700:4700::1111', family: 6 });
  });
});
