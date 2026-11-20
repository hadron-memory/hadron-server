/** A remote may echo credentials anywhere in an otherwise model-visible result (#4000). */
import { describe, expect, it } from 'vitest';
import * as redaction from './secretUseRedaction.js';
describe('secret.use result redaction', () => {
  it('redacts bearer values from strings, keys, arrays and embedded JSON', () => {
    const redact = (redaction as unknown as { redactSecretUse: (value: unknown, auth: unknown) => unknown }).redactSecretUse;
    const secret = 'synthetic-"canary"';
    const result = redact({ [secret]: [secret, JSON.stringify({ token: secret })] }, { type: 'bearer', token: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });
  it('redacts basic credentials in both clear and wire forms', () => {
    const redact = (redaction as unknown as { redactSecretUse: (value: unknown, auth: unknown) => unknown }).redactSecretUse;
    const wire = Buffer.from('sample-user:sample-password').toString('base64');
    const out = JSON.stringify(redact({ body: `sample-user sample-password ${wire}` }, { type: 'basic', username: 'sample-user', password: 'sample-password' }));
    expect(out).not.toContain('sample-user'); expect(out).not.toContain('sample-password'); expect(out).not.toContain(wire);
  });
});
