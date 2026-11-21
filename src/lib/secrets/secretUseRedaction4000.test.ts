/** A remote may echo credentials anywhere in an otherwise model-visible result (#4000). */
import { describe, expect, it } from 'vitest';
import { redactSecretUse } from './secretUseRedaction.js';
describe('secret.use result redaction', () => {
  it('redacts bearer values from strings, keys, arrays and embedded JSON', () => {
    const redact = redactSecretUse;
    const secret = 'synthetic-"canary"';
    const result = redact({ [secret]: [secret, JSON.stringify({ token: secret })] }, { type: 'bearer', token: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });
  it('redacts basic credentials in both clear and wire forms', () => {
    const redact = redactSecretUse;
    const wire = Buffer.from('sample-user:sample-password').toString('base64');
    const out = JSON.stringify(redact({ body: `sample-user sample-password ${wire}` }, { type: 'basic', username: 'sample-user', password: 'sample-password' }));
    expect(out).not.toContain('sample-user'); expect(out).not.toContain('sample-password'); expect(out).not.toContain(wire);
  });
  it('redacts a credential echoed as a JSON number, not just strings', () => {
    const out = JSON.stringify(redactSecretUse({ body: 123456789 }, { type: 'bearer', token: '123456789' }));
    expect(out).not.toContain('123456789');
  });

  it('redacts the base64 form of a bearer and of a header value', () => {
    for (const auth of [{ type: 'bearer' as const, token: 'canary-token-1' }, { type: 'header' as const, name: 'X-Key', value: 'canary-value-2' }]) {
      const secret = auth.type === 'bearer' ? auth.token : auth.value;
      const b64 = Buffer.from(secret).toString('base64');
      expect(JSON.stringify(redactSecretUse({ echoed: b64 }, auth))).not.toContain(b64);
    }
  });
  it('redacts the URL-encoded form in lowercase hex too', () => {
    const secret = 'tok/en+value=';
    const lower = encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(lower).not.toBe(encodeURIComponent(secret));
    expect(JSON.stringify(redactSecretUse({ url: `?t=${lower}` }, { type: 'bearer', token: secret }))).not.toContain(lower);
  });
  it('redacts the form-encoded (URLSearchParams, + for a space) form in lowercase hex too', () => {
    const secret = 'tok en/value';
    const lower = new URLSearchParams({ v: secret }).toString().slice(2).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(lower).toBe('tok+en%2fvalue');
    expect(JSON.stringify(redactSecretUse({ url: `?t=${lower}` }, { type: 'bearer', token: secret }))).not.toContain(lower);
  });

  it('does not expose a credential that occurs inside the ordinary marker', () => {
    const out = JSON.stringify(redactSecretUse({ body: 'A' }, { type: 'bearer', token: 'A' }));
    expect(out).not.toContain('A');
  });

});
