import { describe, expect, it } from 'vitest';
import { isStrictOwner } from './strictOwner.js';

describe('strict owner identity (cor:acl:010:02, DT)', () => {
  it.each([
    ['owner', { userId: 'owner', roles: ['READER'] }, 'owner', true],
    ['owner with platform role', { userId: 'owner', roles: ['ADMIN'] }, 'owner', true],
    ['other platform admin', { userId: 'other', roles: ['ADMIN'] }, 'owner', false],
    ['other org owner', { userId: 'other', orgRole: 'OWNER' }, 'owner', false],
    ['App key', { userId: undefined, appId: 'app' }, 'owner', false],
    ['App member', { userId: 'member', appId: 'app' }, 'owner', false],
    ['impersonated owner', { userId: 'owner', impersonation: { actorUserId: 'admin' } }, 'owner', false],
    ['missing owner', { userId: 'owner' }, null, false],
    ['undefined owner', { userId: 'owner' }, undefined, false],
    ['empty identities', { userId: '' }, '', false],
    ['anonymous', { userId: undefined }, 'owner', false],
  ])('%s', (_name, principal, owner, allowed) => {
    expect(isStrictOwner(principal, owner)).toBe(allowed);
  });
});
