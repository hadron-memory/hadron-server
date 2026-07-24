/**
 * cor:acl:080:04 (#610) — the `listedOnMarketplace` opt-in marketplace
 * catalogue flag on Organization, Memory, and Agent. Covers, per entity:
 *   - defaults to false on create (additive NOT NULL column),
 *   - settable through the per-entity update mutation (set + read back),
 *   - partial-update: omitting the arg leaves it unchanged,
 *   - explicit `null` is treated like omit (no NULL write — Copilot review #688).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });

let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string };
let agent: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'mkt', urn: `mkt-${Date.now()}` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 55001, githubUsername: 'mkt-admin', roles: [] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mkt-mem', class: 'knowledge' },
  });
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'mkt-agent', visibility: 'ORGANIZATION' },
  });
});

describe('listedOnMarketplace — Organization (cor:acl:080:04)', () => {
  it('defaults false; set/read-back; omit and null both preserve', async () => {
    expect((await db.organization.findUnique({ where: { id: org.id } }))?.listedOnMarketplace).toBe(false);
    const updated = await M.updateOrganization({}, { id: org.id, listedOnMarketplace: true }, ctx());
    expect(updated.listedOnMarketplace).toBe(true);
    // omit → unchanged
    await M.updateOrganization({}, { id: org.id, name: 'mkt-renamed' }, ctx());
    expect((await db.organization.findUnique({ where: { id: org.id } }))?.listedOnMarketplace).toBe(true);
    // explicit null → treated as omit (no NULL write on a NOT NULL column)
    await M.updateOrganization({}, { id: org.id, listedOnMarketplace: null }, ctx());
    expect((await db.organization.findUnique({ where: { id: org.id } }))?.listedOnMarketplace).toBe(true);
  });
});

describe('listedOnMarketplace — Memory (cor:acl:080:04)', () => {
  it('defaults false; set/read-back; omit and null both preserve', async () => {
    expect((await db.memory.findUnique({ where: { id: memory.id } }))?.listedOnMarketplace).toBe(false);
    const updated = await M.updateMemory({}, { id: memory.id, listedOnMarketplace: true }, ctx());
    expect(updated.listedOnMarketplace).toBe(true);
    await M.updateMemory({}, { id: memory.id, shortDescription: 'unchanged-flag' }, ctx());
    expect((await db.memory.findUnique({ where: { id: memory.id } }))?.listedOnMarketplace).toBe(true);
    await M.updateMemory({}, { id: memory.id, listedOnMarketplace: null }, ctx());
    expect((await db.memory.findUnique({ where: { id: memory.id } }))?.listedOnMarketplace).toBe(true);
  });
});

describe('listedOnMarketplace — Agent (cor:acl:080:04)', () => {
  it('defaults false; set/read-back; omit and null both preserve', async () => {
    expect((await db.agent.findUnique({ where: { id: agent.id } }))?.listedOnMarketplace).toBe(false);
    const updated = await M.updateAgent({}, { id: agent.id, listedOnMarketplace: true }, ctx());
    expect(updated.listedOnMarketplace).toBe(true);
    await M.updateAgent({}, { id: agent.id, description: 'unchanged-flag' }, ctx());
    expect((await db.agent.findUnique({ where: { id: agent.id } }))?.listedOnMarketplace).toBe(true);
    await M.updateAgent({}, { id: agent.id, listedOnMarketplace: null }, ctx());
    expect((await db.agent.findUnique({ where: { id: agent.id } }))?.listedOnMarketplace).toBe(true);
  });
});
