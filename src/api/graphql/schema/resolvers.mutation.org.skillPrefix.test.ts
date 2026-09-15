/**
 * Organization.skillPrefix — the skill-export prefix stored per org (hadron-cli
 * skill plan D7, Holger 2026-09-15). Pinned: the shape (trailing hyphen
 * included), ADMIN-only, unique across orgs with a typed refusal, explicit
 * null clears, omitted preserves, and it reads back through the org.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let admin: { id: string };
let contributor: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'sp-a', urn: `sp-a-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'sp-b', urn: `sp-b-${t}` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 48601, githubUsername: `sp-admin-${t}` } });
  contributor = await db.user.create({ data: { id: generateId(), githubId: 48602, githubUsername: `sp-contrib-${t}` } });
  for (const o of [orgA, orgB]) {
    await db.orgMember.create({ data: { id: generateId(), organizationId: o.id, userId: admin.id, role: 'ADMIN' } });
  }
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
});

describe('Organization.skillPrefix', () => {
  it('an ADMIN sets it; the stored value IS the literal prefix; it reads back on the org', async () => {
    const updated = await M.updateOrganization({}, { id: orgA.urn, skillPrefix: 'mm-' }, ctx(admin.id));
    expect(updated.skillPrefix).toBe('mm-');
    const read = await Q.organization({}, { ref: orgA.urn }, ctx(contributor.id));
    expect(read.skillPrefix).toBe('mm-');
    // Omitted preserves; explicit null clears.
    expect((await M.updateOrganization({}, { id: orgA.urn, name: 'renamed' }, ctx(admin.id))).skillPrefix).toBe('mm-');
    expect((await M.updateOrganization({}, { id: orgA.urn, skillPrefix: null }, ctx(admin.id))).skillPrefix).toBeNull();
  });

  it('the shape is enforced: lowercase, a trailing hyphen, nothing else', async () => {
    for (const bad of ['mm', 'MM-', '-mm-', 'm m-', 'hadron_', '1a-']) {
      await expect(M.updateOrganization({}, { id: orgA.urn, skillPrefix: bad }, ctx(admin.id))).rejects.toMatchObject({
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    expect((await M.updateOrganization({}, { id: orgA.urn, skillPrefix: 'a1-' }, ctx(admin.id))).skillPrefix).toBe('a1-');
  });

  it('is unique across organizations, with a typed refusal — and a CONTRIBUTOR cannot set it', async () => {
    await M.updateOrganization({}, { id: orgA.urn, skillPrefix: 'mm-' }, ctx(admin.id));
    await expect(M.updateOrganization({}, { id: orgB.urn, skillPrefix: 'mm-' }, ctx(admin.id))).rejects.toMatchObject({
      extensions: { code: 'SKILL_PREFIX_TAKEN' },
    });
    // Two unset orgs do not collide with each other.
    expect((await M.updateOrganization({}, { id: orgB.urn, skillPrefix: null }, ctx(admin.id))).skillPrefix).toBeNull();
    await expect(M.updateOrganization({}, { id: orgA.urn, skillPrefix: 'x-' }, ctx(contributor.id))).rejects.toThrow('Forbidden');
  });
});
