import { describe, it, expect } from 'vitest';
import { cappedLinkLevel, independentReach, linkWriteTargetAdmits, type LinkCapMemory } from './agentMemoryLinkCap.js';

const tenant = { organizationId: 'home', ownerUserId: null };
const knowledge = (over: Partial<LinkCapMemory> = {}): LinkCapMemory => ({
  class: 'knowledge', organizationId: 'foreign', ownerUserId: null, appId: null,
  userMemoryOfAgentId: null, visibility: 'ORGANIZATION', subscriptions: [], ...over,
});

describe('cappedLinkLevel (#1349) — a link is a limit, never a grant', () => {
  it.each([
    ['own org, read-write', knowledge({ organizationId: 'home' }), 'read-write', 'READ_WRITE'],
    ['own org, read', knowledge({ organizationId: 'home' }), 'read', 'READ_ONLY'],
    ['foreign ORG, read-write', knowledge(), 'read-write', null],
    ['foreign ORG, read', knowledge(), 'read', null],
    ['foreign PUBLIC, read-write', knowledge({ visibility: 'PUBLIC' }), 'read-write', 'READ_ONLY'],
    ['foreign App-scoped PUBLIC', knowledge({ visibility: 'PUBLIC', appId: 'other' }), 'read', null],
    ['foreign holding PUBLIC', knowledge({ visibility: 'PUBLIC', userMemoryOfAgentId: 'a' }), 'read', null],
    ['CONTRIBUTOR subscription, read-write', knowledge({ subscriptions: [{ organizationId: 'home', role: 'CONTRIBUTOR' }] }), 'read-write', 'READ_WRITE'],
    ['READER subscription, read-write', knowledge({ subscriptions: [{ organizationId: 'home', role: 'READER' }] }), 'read-write', 'READ_ONLY'],
    ["another org's subscription", knowledge({ subscriptions: [{ organizationId: 'third', role: 'CONTRIBUTOR' }] }), 'read', null],
    ['invalid role on own org', knowledge({ organizationId: 'home' }), 'admin', null],
    ['group in own org', knowledge({ class: 'group', organizationId: 'home' }), 'read', null],
    ['system', knowledge({ class: 'system', organizationId: 'home' }), 'read', null],
  ] as const)('%s → %s', (_label, memory, role, expected) => {
    expect(cappedLinkLevel(tenant, memory, role)).toBe(expected);
  });

  it('a user-owned memory reaches only its owner, the tenant user or the acting user', () => {
    const m = knowledge({ organizationId: null, ownerUserId: 'u1' });
    expect(cappedLinkLevel(tenant, m, 'read')).toBeNull();
    expect(cappedLinkLevel({ ...tenant, userId: 'u1' }, m, 'read-write')).toBe('READ_WRITE');
    expect(cappedLinkLevel({ organizationId: null, ownerUserId: 'u1' }, m, 'read')).toBe('READ_ONLY');
  });

  it('personal, private, app and the same-App row are not capped here', () => {
    for (const cls of ['personal', 'private', 'app']) {
      expect(independentReach(tenant, knowledge({ class: cls }))).toBeUndefined();
    }
    expect(independentReach({ ...tenant, appId: 'x' }, knowledge({ appId: 'x' }))).toBeUndefined();
    expect(independentReach({ ...tenant, appId: 'y' }, knowledge({ appId: 'x' }))).toBeNull();
  });
});

describe('linkWriteTargetAdmits (#1349, Colin on #2002) — a write target picked from links', () => {
  const personal = knowledge({ class: 'personal', organizationId: null, ownerUserId: 'u1', userId: 'u1' });
  it('a personal or private memory only for its own user', () => {
    expect(linkWriteTargetAdmits(tenant, personal, 'read-write')).toBe(false);
    expect(linkWriteTargetAdmits({ ...tenant, userId: 'u2' }, personal, 'read-write')).toBe(false);
    expect(linkWriteTargetAdmits({ ...tenant, userId: 'u1' }, personal, 'read-write')).toBe(true);
    expect(linkWriteTargetAdmits({ ...tenant, userId: 'u1' }, { ...personal, class: 'private' }, 'read-write')).toBe(true);
    expect(linkWriteTargetAdmits({ ...tenant, userId: 'u1' }, personal, 'read')).toBe(false);
  });
  it('the strict owner is userId, not ownerUserId', () => {
    const skewed = knowledge({ class: 'personal', organizationId: null, ownerUserId: 'u2', userId: 'u1' });
    expect(linkWriteTargetAdmits({ ...tenant, userId: 'u2' }, skewed, 'read-write')).toBe(false);
    expect(linkWriteTargetAdmits({ ...tenant, userId: 'u1' }, skewed, 'read-write')).toBe(true);
  });
  it('an app-class memory is never a write target through a link, even for its own App', () => {
    const appMem = knowledge({ class: 'app', appId: 'x' });
    expect(linkWriteTargetAdmits(tenant, appMem, 'read-write')).toBe(false);
    expect(linkWriteTargetAdmits({ ...tenant, appId: 'x' }, appMem, 'read-write')).toBe(false);
  });
  it('knowledge only at a capped READ_WRITE', () => {
    expect(linkWriteTargetAdmits(tenant, knowledge({ organizationId: 'home' }), 'read-write')).toBe(true);
    expect(linkWriteTargetAdmits(tenant, knowledge({ visibility: 'PUBLIC' }), 'read-write')).toBe(false);
    expect(linkWriteTargetAdmits(tenant, knowledge(), 'read-write')).toBe(false);
  });
});
