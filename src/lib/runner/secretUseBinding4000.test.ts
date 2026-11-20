import { describe, expect, it } from 'vitest';
import * as secrets from './secrets.js';

// S5: a signed prefix is an HTTPS origin and path boundary, independent of the mutable kind metadata.
describe('secret.use signed binding (#4000)', () => {
  const check = (url: string, signed: string, metadata: string) =>
    (secrets as unknown as { assertSecretUseBinding: (url: string, signed: string, metadata: string) => void })
      .assertSecretUseBinding(url, signed, metadata);
  it('accepts only a target inside both signed and metadata boundaries', () => {
    expect(() => check('https://api.example.test/v1/orders', 'https://api.example.test/v1', 'https://api.example.test/v1/')).not.toThrow();
    for (const target of ['http://api.example.test/v1/x', 'https://api.example.test.evil/v1/x', 'https://api.example.test/v10/x', 'https://api.example.test/v1/../admin']) {
      expect(() => check(target, 'https://api.example.test/v1', 'https://api.example.test/')).toThrow();
    }
    expect(() => check('https://api.example.test/v1/x', 'https://api.example.test/v1', 'https://api.example.test/v2')).toThrow();
    expect(() => check('https://api.example.test/v1/x', 'http://api.example.test/v1', 'https://api.example.test/')).toThrow();
  });
});
