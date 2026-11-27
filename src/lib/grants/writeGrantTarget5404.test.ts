/**
 * #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02 `memory.write`): the pure predicates of the write gate. `grantCoversLoc` and
 * `isUserlessRunPrincipal` are moved verbatim from the retired 0083 module's tests (src/lib/appWriteGrant.test.ts); the target rule
 * is restated for `memoryWriteTargetRefusal`, which keeps 0083's rule (Q3, Peter #155843, Victor #155845) and names each refusal
 * on its own where 0083 said `tenancy`: a Worker's memory, a session memory, and (as `memory.read`, #5345) a user-owned memory.
 */
import { describe, expect, it } from 'vitest';
import { grantCoversLoc, isUserlessRunPrincipal, memoryWriteTargetRefusal } from './writeGrant.js';

describe('grantCoversLoc', () => {
  it.each([
    ['reports:team-progress', 'reports:team-progress', true],
    ['reports:team-progress', 'reports:team-progress:2026', true],
    ['reports:team-progress', 'reports:team-progress:2026:deep', true],
    ['reports:team-progress', 'reports:team-progressX', false],
    ['reports:team-progress', 'reports:team-progressX:child', false],
    ['reports:team-progress', 'reports:team-progres', false],
    ['reports:team-progress', 'reports', false],
    ['reports:team-progress', 'x:reports:team-progress', false],
    ['a_b', 'axb', false],
    ['a_b', 'a_b:c', true],
  ])('prefix %s vs loc %s -> %s', (prefix, loc, covered) => {
    expect(grantCoversLoc(prefix, loc)).toBe(covered);
  });
});

describe('isUserlessRunPrincipal', () => {
  it.each([
    [{ clientId: 'run:r1', appId: 'a' }, true],
    [{ clientId: 'run:r1', appId: 'a', userId: 'u' }, false],
    [{ clientId: 'run:r1' }, false],
    [{ clientId: 'run:r1', appId: 'a', sessionId: 's' }, false],
    [{ clientId: 'run:r1', appId: 'a', impersonation: { adminUserId: 'x' } }, false],
    [{ clientId: 'appkey:k', appId: 'a' }, false],
    [{ clientId: 'user:u', appId: 'a', userId: 'u' }, false],
    [{ appId: 'a' }, false],
  ] as const)('%j -> %s', (auth, expected) => {
    expect(isUserlessRunPrincipal(auth as never)).toBe(expected);
  });
});

describe('memoryWriteTargetRefusal', () => {
  const app = { id: 'app1', organizationId: 'org1', ownerUserId: null };
  const mem = (over: Record<string, unknown> = {}) => ({
    id: 'm', class: 'knowledge', userId: null, organizationId: 'org1', appId: null, ownerUserId: null, deletedAt: null,
    isEncrypted: false, isInstallMemory: false, userMemoryOfAgentId: null, createdBy: null, workerOf: [], ...over,
  }) as never;
  it('refuses a deleted, an encrypted (every class) and an install memory', () => {
    expect(memoryWriteTargetRefusal(app as never, mem({ deletedAt: new Date() }))).toBe('deleted');
    for (const c of ['knowledge', 'personal', 'private', 'app', 'system']) {
      expect(memoryWriteTargetRefusal(app as never, mem({ class: c, isEncrypted: true, userId: 'u', appId: 'app1' }))).toBe('encrypted');
    }
    expect(memoryWriteTargetRefusal(app as never, mem({ isInstallMemory: true }))).toBe('install-memory');
  });
  it('a shared memory must be held by the App\'s own org or be its team space', () => {
    expect(memoryWriteTargetRefusal(app as never, mem())).toBeNull();
    expect(memoryWriteTargetRefusal(app as never, mem({ organizationId: 'org2' }))).toBe('tenancy');
    expect(memoryWriteTargetRefusal(app as never, mem({ organizationId: null, ownerUserId: 'u' }))).toBe('user-owned');
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'app', appId: 'app1' }))).toBeNull();
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'app', appId: 'app2' }))).toBe('tenancy');
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'app', appId: 'app1', workerOf: [{ id: 'w' }] }))).toBe('worker-memory');
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'app', appId: 'app1', userMemoryOfAgentId: 'ag' }))).toBe('session-memory');
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'app', appId: 'app2', organizationId: 'org1' }))).toBe('tenancy');
    const userApp = { id: 'app1', organizationId: null, ownerUserId: 'u' };
    expect(memoryWriteTargetRefusal(userApp as never, mem({ organizationId: null }))).toBe('tenancy');
    expect(memoryWriteTargetRefusal(userApp as never, mem({ class: 'app', appId: 'app1', organizationId: null }))).toBeNull();
  });
  it('#2710: a class=system memory is never a target, even one the App\'s own org holds', () => {
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'system' }))).toBe('system');
    expect(memoryWriteTargetRefusal({ id: 'app1', organizationId: null, ownerUserId: 'u' } as never, mem({ class: 'system', organizationId: null }))).toBe('system');
  });
  it('a personal or private memory needs an owner', () => {
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'personal', userId: 'u', organizationId: null }))).toBeNull();
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'private', userId: 'u', organizationId: 'org2' }))).toBeNull();
    expect(memoryWriteTargetRefusal(app as never, mem({ class: 'private', userId: null }))).toBe('no-owner');
  });
});
