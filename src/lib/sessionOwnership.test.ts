import { describe, expect, it } from 'vitest';
import { ownsSession } from './sessionOwnership.js';

const userSession = { userId: 'alice', appId: 'app-a' };
const appSession = { userId: null, appId: 'app-a' };

describe('session attribution ownership (#1662)', () => {
  it.each([
    [{ userId: 'alice' }, userSession, true],
    [{ userId: 'bob' }, userSession, false],
    [{ appId: 'app-a' }, userSession, true],
    [{ appId: 'app-a' }, appSession, true],
    [{ appId: 'app-b' }, userSession, false],
    [{ appId: 'app-b' }, appSession, false],
    [{ userId: 'bob', appId: 'app-a' }, userSession, false],
    [{ userId: 'alice', appId: 'app-b' }, userSession, true],
    [{ userId: 'alice', appId: 'app-a' }, appSession, false],
    [{ userId: 'alice', impersonation: {} }, userSession, false],
    [{ appId: 'app-a', impersonation: {} }, appSession, false],
    [{}, appSession, false],
    [{}, { userId: null, appId: null }, false],
    [{ appId: 'app-a' }, { userId: 'alice', appId: null }, false],
  ])('principal %j on %j owns=%s', (principal, session, expected) => {
    expect(ownsSession(principal, session)).toBe(expected);
  });
});
