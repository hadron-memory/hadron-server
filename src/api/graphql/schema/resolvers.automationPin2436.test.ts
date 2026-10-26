/**
 * #2436: adopt, re-adopt and preview share ONE admission predicate, and its refusal is plain,
 * naming who may adopt (cor:agt:010:01 today-rule: the run-as user; otherwise the App's owner,
 * an org ADMIN/OWNER, a platform admin on an org-owned App). cor:dmo:050:12's wider "manager"
 * (owner-role members) is deliberately NOT admitted yet — the widening is the open call in
 * cor:agt:010:01, and the owner-role pins below keep that gap visible rather than silent.
 * Red first on main: every verbatim DENIED pin fails against the old "requires its manager"
 * text; the positive pins pass on main and pin the shared predicate against drift.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { automationPinQueries, automationPinMutations } from './resolvers.automationPin.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

const Q = automationPinQueries as any;
const M = automationPinMutations as any;
/** The ONE plain who-may refusal, pinned verbatim: a door that drifts to its own wording (or back to the
 * ambiguous "manager" the gate does not implement — the #2436 report) fails here, not in a user's terminal. */
const DENIED = "Only the trigger's run-as user may adopt this automation; a trigger with no run-as user may be previewed, approved, declined and re-adopted only by the App's owner, or by an ADMIN or OWNER of the organization that owns the App, or by a platform admin on an organization-owned App.";

/** Every admission surface, as callables a refused persona walks in one loop: the sharing pin. */
const DOORS = (input: { triggerKind: 'SCHEDULE'; triggerRef: string }) => (ctx: unknown): Array<[string, () => Promise<unknown>]> => [
  ['previewAutomation', () => Q.previewAutomation({}, input, ctx)],
  ['automationApproval', () => Q.automationApproval({}, input, ctx)],
  ['approveAutomation', () => M.approveAutomation({}, { ...input, expectedHash: 'a'.repeat(64) }, ctx)],
  ['declineAutomation', () => M.declineAutomation({}, input, ctx)],
  ['reAdoptAutomation', () => M.reAdoptAutomation({}, { ...input, expectedHash: 'a'.repeat(64) }, ctx)],
];
const refusesEverywhere = async (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, ctx: unknown) => {
  for (const [door, call] of DOORS(input)(ctx)) {
    const err = await call().catch((e: unknown) => e);
    expect(err, door).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect((err as Error).message, door).toBe(DENIED);
  }
};

/** An org-owned App with a userless schedule over an App-readable memory (class 'app', so the run
 * principal passes the #2411 cause-5 read check) and one persona per arm of the today-rule. */
async function orgFixture() {
  const org = await db.organization.create({ data: { name: 'Gate', urn: 'gate.test' } });
  const persona = async (handle: string, role: 'ADMIN' | 'OWNER' | 'CONTRIBUTOR' | 'none') => {
    const user = await db.user.create({ data: { handle } });
    if (role !== 'none') await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role } });
    return user;
  };
  const orgAdmin = await persona('gate-admin', 'ADMIN');
  const orgOwner = await persona('gate-org-owner', 'OWNER');
  const plain = await persona('gate-plain', 'CONTRIBUTOR');
  const outsider = await persona('gate-outsider', 'none');
  const platformAdmin = await db.user.create({ data: { handle: 'gate-platform', roles: ['ADMIN'] } });
  const ownerRole = await persona('gate-owner-role', 'CONTRIBUTOR');
  const app = await db.app.create({ data: { name: 'Gate', urn: 'gate.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: ownerRole.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'gate.test:flow', class: 'app', appId: app.id, organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const appOnly = (name: string, userId: string | null = null) =>
    db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, userId, name, cron: '* * * * *', entryNodeUrn: 'hrn:node:gate.test:flow:entry' } });
  const ctx = (user: { id: string }, roles: string[] = []) => ({ db, userId: user.id, roles });
  return { org, app, memory, orgAdmin, orgOwner, plain, outsider, platformAdmin, ownerRole, appOnly, ctx };
}

/** A USER-owned App holding trigger rows from before a transfer (the only way they arise — every trigger
 * table has a non-null organization_id, and createAgentSchedule writes the App's org, null here; #2441's
 * liveApp note accepts any row org on a user-owned App). The memory keeps its pre-transfer org — the pin
 * walk is org-scoped — and is the App's own class 'app' memory, so the App principal can read it (#2411
 * cause 5) and the owner reads it through App participation. */
async function userOwnedFixture() {
  const origin = await db.organization.create({ data: { name: 'Solo origin', urn: 'solo.test' } });
  const owner = await db.user.create({ data: { handle: 'solo-owner' } });
  const ownerRole = await db.user.create({ data: { handle: 'solo-owner-role' } });
  const platformAdmin = await db.user.create({ data: { handle: 'solo-platform', roles: ['ADMIN'] } });
  const app = await db.app.create({ data: { name: 'Solo', urn: 'solo-owner:app', ownerUserId: owner.id } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: ownerRole.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'solo-owner:flow', class: 'app', appId: app.id, organizationId: origin.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const appOnly = await db.agentSchedule.create({ data: { id: generateId(), organizationId: origin.id, appId: app.id, userId: null, name: 'Solo flow', cron: '* * * * *', entryNodeUrn: 'hrn:node:solo-owner:flow:entry' } });
  const ctx = (user: { id: string }, roles: string[] = []) => ({ db, userId: user.id, roles });
  return { origin, owner, ownerRole, platformAdmin, app, memory, appOnly, ctx };
}

describe('#2436 who may adopt an App-only trigger', () => {
  it('an org ADMIN and an org OWNER adopt (positive arms of the today-rule)', async () => {
    const f = await orgFixture();
    const adopt = async (user: { id: string }, triggerRef: string) => {
      const detail = await Q.automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef }, f.ctx(user));
      expect(detail.state).toBe('UNADOPTED');
      await expect(M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef, expectedHash: detail.hash }, f.ctx(user))).resolves.toBe(true);
    };
    await adopt(f.orgAdmin, (await f.appOnly('Admin flow')).id);
    await adopt(f.orgOwner, (await f.appOnly('Owner flow')).id);
    expect(await db.automationAdoptionEvent.count({ where: { appId: f.app.id, action: 'APPROVE' } })).toBe(2);
  });

  it('a plain member, an outsider and an owner-role member are refused on every door with the one plain message', async () => {
    const f = await orgFixture();
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: (await f.appOnly('Gated flow')).id };
    for (const persona of [f.plain, f.outsider, f.ownerRole]) {
      await refusesEverywhere(input, f.ctx(persona));
      const page = await Q.automationApprovals({}, { appRef: f.app.id }, f.ctx(persona));
      expect(page.rows).toEqual([]);
    }
    expect(await db.automationAdoptionEvent.count()).toBe(0);
  });

  it('a trigger WITH a run-as user keeps its run-as-user arm: a manager is refused with the same message', async () => {
    const f = await orgFixture();
    await db.appMember.create({ data: { appId: f.app.id, userId: f.orgAdmin.id, role: 'member' } });
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: (await f.appOnly('Owned flow', f.orgAdmin.id)).id };
    await refusesEverywhere(input, f.ctx(f.orgOwner));
    const detail = await Q.automationApproval({}, input, f.ctx(f.orgAdmin));
    await expect(M.approveAutomation({}, { ...input, expectedHash: detail.hash }, f.ctx(f.orgAdmin))).resolves.toBe(true);
  });

  it('the owner of a user-owned App adopts its App-only trigger (strict owner arm)', async () => {
    const f = await userOwnedFixture();
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.appOnly.id };
    const detail = await Q.automationApproval({}, input, f.ctx(f.owner));
    expect(detail.state).toBe('UNADOPTED');
    await expect(M.approveAutomation({}, { ...input, expectedHash: detail.hash }, f.ctx(f.owner))).resolves.toBe(true);
    const page = await Q.automationApprovals({}, { appRef: f.app.id }, f.ctx(f.owner));
    expect(page.rows.map((r: any) => [r.triggerKind, r.triggerRef, r.state])).toEqual([['SCHEDULE', f.appOnly.id, 'ADOPTED']]);
  });

  it('an owner-role member and a platform admin are refused on a user-owned App: only the owner adopts there', async () => {
    const f = await userOwnedFixture();
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.appOnly.id };
    await refusesEverywhere(input, f.ctx(f.ownerRole));
    await refusesEverywhere(input, f.ctx(f.platformAdmin, ['ADMIN']));
  });

  it('a platform admin adopts on an organization-owned App', async () => {
    const f = await orgFixture();
    const triggerRef = (await f.appOnly('Platform flow')).id;
    const ctx = f.ctx(f.platformAdmin, ['ADMIN']);
    const detail = await Q.automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef }, ctx);
    await expect(M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef, expectedHash: detail.hash }, ctx)).resolves.toBe(true);
  });
});
