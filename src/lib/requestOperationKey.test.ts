import { describe, expect, it } from 'vitest';
import { getRequestOperationKey, requestOperationKeyStorage, resolveRequestOperationKey, stageRequestOperationKey } from './requestOperationKey.js';

const key = Buffer.alloc(32, 71).toString('base64');
describe('operation key transport', () => {
  it.each(['', 'not-base64', [key], key + key])('unauthenticated input is refused before its format is considered: %s', supplied => {
    expect(() => stageRequestOperationKey(supplied, {})).toThrow(expect.objectContaining({ extensions: { code: 'UNAUTHENTICATED' } }));
  });
  it.each(['', 'not-base64', [key], key + key, key.slice(0, -1)])('malformed or duplicate supply is refused: %s', supplied => {
    requestOperationKeyStorage.run({}, () => {
      expect(() => stageRequestOperationKey(supplied, { appId: 'app' })).toThrow(expect.objectContaining({ extensions: { code: 'BAD_UNLOCK_INPUT' } }));
      expect(getRequestOperationKey()).toBeNull();
    });
  });
  it('refuses impersonated supply without staging', () => {
    requestOperationKeyStorage.run({}, () => {
      expect(() => stageRequestOperationKey(key, { appId: 'app', impersonation: {} })).toThrow(expect.objectContaining({ extensions: { code: 'FORBIDDEN' } }));
      expect(getRequestOperationKey()).toBeNull();
    });
  });
  it('refuses a user credential without an App context', () => {
    expect(() => stageRequestOperationKey(key, { userId: 'user' })).toThrow(expect.objectContaining({ extensions: { code: 'FORBIDDEN' } }));
  });
  it('is absent outside the request and in a new empty request', () => {
    requestOperationKeyStorage.run({}, () => {
      stageRequestOperationKey(key, { appId: 'app' });
      expect(getRequestOperationKey()?.raw).toEqual(Buffer.alloc(32, 71));
    });
    expect(getRequestOperationKey()).toBeNull();
    requestOperationKeyStorage.run({}, () => expect(getRequestOperationKey()).toBeNull());
  });
  it.each(['', 'not-base64', Buffer.alloc(32, 72).toString('base64')])('dual supply refuses invalid or different material generically: %s', legacy => {
    requestOperationKeyStorage.run({}, () => {
      stageRequestOperationKey(key, { appId: 'app' });
      expect(() => resolveRequestOperationKey(legacy)).toThrow(expect.objectContaining({ extensions: { code: 'BAD_UNLOCK_INPUT' } }));
    });
  });
});
