/** #5075: ownerRefOf / ownerOfWork / aiConfigTenantFor, the pure owner rules (cor:dmo:170:05). */
import { describe, expect, it } from 'vitest';
import { ownerOfWork, ownerRefOf } from './owner.js';
import { aiConfigTenantFor } from './aiConfig.js';

const org = { organizationId: 'o1', ownerUserId: null };
const person = { organizationId: null, ownerUserId: 'u1' };
const nobody = { organizationId: null, ownerUserId: null };

describe('ownerRefOf', () => {
  it('names the person first, then the organization, and nothing for an ownerless row or no row', () => {
    expect(ownerRefOf(person)).toEqual({ userId: 'u1' });
    expect(ownerRefOf(org)).toEqual({ organizationId: 'o1' });
    expect(ownerRefOf(nobody)).toBeNull();
    expect(ownerRefOf(null)).toBeNull();
    expect(ownerRefOf({ organizationId: 'o1', ownerUserId: 'u1' })).toEqual({ userId: 'u1' });
  });
});

describe('ownerOfWork', () => {
  it('is the App\'s owner when there is an App, else the Agent\'s, and an ownerless App does not fall through to the Agent', () => {
    expect(ownerOfWork(org, person)).toEqual({ organizationId: 'o1' });
    expect(ownerOfWork(null, person)).toEqual({ userId: 'u1' });
    expect(ownerOfWork(nobody, org)).toBeNull();
    expect(ownerOfWork(null, null)).toBeNull();
  });
});

describe('aiConfigTenantFor', () => {
  it('orders: a person\'s App, then an explicit organization, then the owner of the work', () => {
    expect(aiConfigTenantFor({ app: person, agent: org, organizationId: 'x' })).toEqual({ userId: 'u1' });
    expect(aiConfigTenantFor({ app: org, agent: person, organizationId: 'x' })).toEqual({ organizationId: 'x' });
    expect(aiConfigTenantFor({ app: org, agent: person, organizationId: null })).toEqual({ organizationId: 'o1' });
    expect(aiConfigTenantFor({ app: null, agent: person, organizationId: null })).toEqual({ userId: 'u1' });
  });
  it('separates the server context from an unowned row: only the server context is "server"', () => {
    expect(aiConfigTenantFor({ app: null, agent: null, organizationId: null })).toEqual({ server: true });
    expect(aiConfigTenantFor({ app: nobody, agent: null, organizationId: null })).toEqual({ unowned: true });
    expect(aiConfigTenantFor({ app: null, agent: nobody, organizationId: null })).toEqual({ unowned: true });
    expect(aiConfigTenantFor({ app: nobody, agent: org, organizationId: null })).toEqual({ unowned: true });
  });
});
