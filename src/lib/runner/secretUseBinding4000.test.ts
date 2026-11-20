import { describe, expect, it } from 'vitest';
import * as secrets from './secrets.js';
const { assertSecretUseBinding } = secrets;

// S5: a signed prefix is an HTTPS origin and path boundary, independent of the mutable kind metadata.
describe('secret.use signed binding (#4000)', () => {
  const check = assertSecretUseBinding;
  it('accepts only a target inside both signed and metadata boundaries', () => {
    expect(check('https://API.example.test:443/v1/orders', 'https://api.example.test/v1', 'https://api.example.test/v1/')).toBe('https://api.example.test/v1/orders');
    for (const target of ['http://api.example.test/v1/x', 'https://api.example.test.evil/v1/x', 'https://api.example.test/v10/x', 'https://api.example.test/v1/../admin', 'https://api.example.test/v1%2f..%2fadmin']) {
      expect(() => check(target, 'https://api.example.test/v1', 'https://api.example.test/')).toThrow();
    }
    expect(() => check('https://api.example.test/v1/x', 'https://api.example.test/v1', 'https://api.example.test/v2')).toThrow();
    expect(() => check('https://api.example.test/v1/x', 'http://api.example.test/v1', 'https://api.example.test/')).toThrow();
  });
});

describe('secret.use header binding (#4000)', () => {
  it('binds the derived auth header and refuses a model-set copy, case insensitively', () => {
    const validate = (secrets as unknown as { assertSecretUseHeader: (header: string, auth: unknown, headers: Record<string, string>) => void }).assertSecretUseHeader;
    expect(() => validate('Authorization', { type: 'bearer', token: 'synthetic' }, {})).not.toThrow();
    expect(() => validate('authorization', { type: 'basic', username: 'u', password: 'p' }, {})).not.toThrow();
    expect(() => validate('x-api-key', { type: 'header', name: 'X-Api-Key', value: 'synthetic' }, {})).not.toThrow();
    expect(() => validate('x-api-key', { type: 'bearer', token: 'synthetic' }, {})).toThrow();
    expect(() => validate('Authorization', { type: 'bearer', token: 'synthetic' }, { AUTHORIZATION: 'override' })).toThrow();
    expect(() => validate('X-Bad\r\nInjected', { type: 'header', name: 'X-Bad\r\nInjected', value: 'synthetic' }, {})).toThrow();
  });
});
