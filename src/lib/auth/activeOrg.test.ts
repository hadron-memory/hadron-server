/**
 * Spec 049 Phase 1 — the active-organization ladder (D-2026-09-13-003).
 *
 * Every rung is a claim about what OUTRANKS what, and each test below removes
 * one input to show the next rung takes over. The two ends of the membership
 * count are pinned separately because they were the decision's weak spot:
 * zero memberships must NOT refuse (spec 048 made org-less users ordinary),
 * and two-or-more with nothing chosen MUST.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolveActiveOrg } from './activeOrg.js';

let user: { id: string };
let orgA: { id: string };
let orgB: { id: string };

async function org(name: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  return db.organization.create({
    data: { id: generateId(), name, urn: `${name}-${suffix}.com` },
    select: { id: true },
  });
}
async function join(o: { id: string }, u: { id: string }) {
  await db.orgMember.create({
    data: { id: generateId(), organizationId: o.id, userId: u.id, role: 'CONTRIBUTOR' },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  user = await db.user.create({
    data: { id: generateId(), githubId: 97811, githubUsername: `ao-${suffix}`, roles: ['READER'] },
    select: { id: true },
  });
  orgA = await org('ao-a');
  orgB = await org('ao-b');
});

describe('rung 1 — named in the call', () => {
  it('a member naming an org gets it, whatever else is set', async () => {
    await join(orgA, user);
    await join(orgB, user);
    const r = await resolveActiveOrg(db, { userId: user.id, namedOrgId: orgB.id, selectedOrgId: orgA.id });
    expect(r).toEqual({ kind: 'org', organizationId: orgB.id, source: 'named' });
  });

  it('a NON-member naming an org is refused, never widened, and never falls through', async () => {
    // Falling through would silently answer a different question than asked.
    await join(orgA, user);
    const r = await resolveActiveOrg(db, { userId: user.id, namedOrgId: orgB.id, selectedOrgId: orgA.id });
    expect(r).toEqual({ kind: 'required', reason: 'named_not_member', memberOrgIds: [orgA.id] });
  });
});

describe('rung 2 — the active App', () => {
  it("an org-owned App's org wins over the explicit selection, for a member", async () => {
    await join(orgA, user);
    await join(orgB, user);
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, name: 'A', urn: `ao-a-${generateId()}:app` },
    });
    const r = await resolveActiveOrg(db, { userId: user.id, activeAppId: app.id, selectedOrgId: orgB.id });
    expect(r).toEqual({ kind: 'org', organizationId: orgA.id, source: 'app' });
  });

  it("an org-owned App whose org the caller is NOT a member of falls through (an AppMember need not be an OrgMember)", async () => {
    await join(orgB, user);
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, name: 'A', urn: `ao-a-${generateId()}:app` },
    });
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
    const r = await resolveActiveOrg(db, { userId: user.id, activeAppId: app.id });
    // Not widened to orgA; the single membership decides instead.
    expect(r).toEqual({ kind: 'org', organizationId: orgB.id, source: 'single-membership' });
  });

  it('an UNINSTALLED App no longer wins — the pin can outlive the install (Codex/Copilot on #1158)', async () => {
    await join(orgA, user);
    await join(orgB, user);
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, name: 'A', urn: `ao-a-${generateId()}:app`, uninstalledAt: new Date() },
    });
    const r = await resolveActiveOrg(db, { userId: user.id, activeAppId: app.id, selectedOrgId: orgB.id });
    expect(r).toEqual({ kind: 'org', organizationId: orgB.id, source: 'selection' });
  });

  it('a PERSONAL (user-owned) App has no organization and is skipped', async () => {
    await join(orgA, user);
    await join(orgB, user);
    const app = await db.app.create({
      data: { id: generateId(), ownerUserId: user.id, name: 'mine', urn: `ao-u-${generateId()}:mine` },
    });
    const r = await resolveActiveOrg(db, { userId: user.id, activeAppId: app.id, selectedOrgId: orgB.id });
    expect(r).toEqual({ kind: 'org', organizationId: orgB.id, source: 'selection' });
  });
});

describe('rung 3 — the explicit selection is re-authorized, never trusted', () => {
  it('a selection the caller is still a member of holds', async () => {
    await join(orgA, user);
    await join(orgB, user);
    const r = await resolveActiveOrg(db, { userId: user.id, selectedOrgId: orgB.id });
    expect(r).toEqual({ kind: 'org', organizationId: orgB.id, source: 'selection' });
  });

  it('a selection whose membership was REVOKED is dropped, not honoured', async () => {
    await join(orgA, user);
    await join(orgB, user);
    await db.orgMember.updateMany({
      where: { organizationId: orgB.id, userId: user.id },
      data: { deletedAt: new Date() },
    });
    const r = await resolveActiveOrg(db, { userId: user.id, selectedOrgId: orgB.id });
    expect(r).toEqual({ kind: 'org', organizationId: orgA.id, source: 'single-membership' });
  });
});

describe('rungs 4 and 5 — the membership count', () => {
  it('exactly one membership resolves to it', async () => {
    await join(orgA, user);
    expect(await resolveActiveOrg(db, { userId: user.id })).toEqual({
      kind: 'org', organizationId: orgA.id, source: 'single-membership',
    });
  });

  it('ZERO memberships resolve to the user-owned view — never a refusal', async () => {
    expect(await resolveActiveOrg(db, { userId: user.id })).toEqual({ kind: 'user-owned' });
  });

  it('two or more with nothing chosen is the refusal, carrying the member list', async () => {
    await join(orgA, user);
    await join(orgB, user);
    const r = await resolveActiveOrg(db, { userId: user.id });
    expect(r.kind).toBe('required');
    if (r.kind === 'required') {
      expect(r.reason).toBe('ambiguous');
      expect(new Set(r.memberOrgIds)).toEqual(new Set([orgA.id, orgB.id]));
    }
  });

  it('a soft-deleted organization is not a membership: not selectable, not the single one, not counted', async () => {
    // An org's soft-delete leaves OrgMember rows in place (Codex/Copilot on #1158).
    await join(orgA, user);
    await join(orgB, user);
    await db.organization.update({ where: { id: orgB.id }, data: { deletedAt: new Date() } });
    expect(await resolveActiveOrg(db, { userId: user.id, selectedOrgId: orgB.id })).toEqual({
      kind: 'org', organizationId: orgA.id, source: 'single-membership',
    });
    expect(await resolveActiveOrg(db, { userId: user.id, namedOrgId: orgB.id })).toEqual({
      kind: 'required', reason: 'named_not_member', memberOrgIds: [orgA.id],
    });
    await db.organization.update({ where: { id: orgA.id }, data: { deletedAt: new Date() } });
    expect(await resolveActiveOrg(db, { userId: user.id })).toEqual({ kind: 'user-owned' });
  });

  it('impersonation collapses the memberships to the one shared org', async () => {
    await join(orgA, user);
    await join(orgB, user);
    expect(await resolveActiveOrg(db, { userId: user.id, restrictToOrgId: orgA.id })).toEqual({
      kind: 'org', organizationId: orgA.id, source: 'single-membership',
    });
  });
});
