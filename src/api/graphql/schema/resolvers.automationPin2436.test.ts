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
import { GraphQLError } from 'graphql';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { storedAutomationPin } from '../../../lib/automation/pins.js';
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
  for (const role of ['ADMIN', 'OWNER'] as const) {
    const adopter = (f: Awaited<ReturnType<typeof orgFixture>>) => role === 'ADMIN' ? f.orgAdmin : f.orgOwner;

    it(`#2499 an org ${role} previews without changing consent or recording an event`, async () => {
      const f = await orgFixture();
      const trigger = await f.appOnly('Preview flow');
      const pin = await Q.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: trigger.id }, f.ctx(adopter(f)));

      expect(pin).toMatchObject({ format: 'hadron-automation-pin-v4', entryId: expect.any(String) });
      expect(pin.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.values(pin.nodes)).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: expect.objectContaining({ memoryId: f.memory.id, content: 'approved' }) }),
      ]));
      expect(await db.agentSchedule.findUniqueOrThrow({ where: { id: trigger.id } })).toEqual(trigger);
      expect(await db.automationAdoptionEvent.count({ where: { appId: f.app.id } })).toBe(0);
    });

    it(`#2499 an org ${role} declines an unadopted trigger without changing it and records DECLINE`, async () => {
      const f = await orgFixture();
      const user = adopter(f);
      const trigger = await f.appOnly('Decline flow');

      expect(await M.declineAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: trigger.id }, f.ctx(user))).toBe(true);

      expect(await db.agentSchedule.findUniqueOrThrow({ where: { id: trigger.id } })).toEqual(trigger);
      expect(await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id } })).toEqual([
        expect.objectContaining({ action: 'DECLINE', actorUserId: user.id, appId: f.app.id,
          organizationId: f.org.id, triggerKind: 'SCHEDULE', triggerRef: trigger.id, pinHash: null }),
      ]);
    });

    it(`#2499 an org ${role} re-adopts changed automation using its returned hash and records the new consent`, async () => {
      const f = await orgFixture();
      const user = adopter(f);
      const input = { triggerKind: 'SCHEDULE' as const, triggerRef: (await f.appOnly('Re-adopt flow')).id };
      const original = await Q.previewAutomation({}, input, f.ctx(user));
      expect(await M.approveAutomation({}, { ...input, expectedHash: original.hash }, f.ctx(user))).toBe(true);
      await db.node.update({ where: { id: original.entryId }, data: { content: 'review this changed automation' } });
      expect((await Q.automationApproval({}, input, f.ctx(user))).state).toBe('CHANGED');
      const preview = await Q.previewAutomation({}, input, f.ctx(user));
      expect(preview.hash).not.toBe(original.hash);
      const before = await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id } });

      expect(await M.reAdoptAutomation({}, { ...input, expectedHash: preview.hash }, f.ctx(user))).toBe(true);

      const trigger = await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } });
      expect(trigger.automationPin).toEqual(storedAutomationPin(preview));
      expect(trigger).toMatchObject({ entryNodeId: preview.entryId, updatedBy: user.id });
      expect((await Q.automationApproval({}, input, f.ctx(user))).state).toBe('ADOPTED');
      const added = await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id, id: { notIn: before.map(e => e.id) } } });
      expect(added).toEqual([
        expect.objectContaining({ action: 'APPROVE', actorUserId: user.id, appId: f.app.id,
          organizationId: f.org.id, triggerKind: 'SCHEDULE', triggerRef: input.triggerRef, pinHash: preview.hash }),
      ]);
      expect(await db.automationAdoptionEvent.count({ where: { appId: f.app.id } })).toBe(before.length + 1);
    });
  }

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

/**
 * #2580: the adoption door decides twice — an unlocked load, then a fresh load under the trigger-row lock inside
 * withAuthorizedTx — and the second decision is the one that counts. These pins hold that line with the real
 * gate, locks and writes; the only test seam is a delegating db that pauses the door's `$transaction` entry, i.e.
 * after the admitted pre-lock load and before the locked reload. While it is paused, a SECOND connection takes away
 * the deciding org role and COMMITs, then the door is released. Nothing else admits the actor: the App is
 * org-owned (no owner arm), the actor carries no platform role, and the trigger has no run-as user.
 */
describe('#2580 the locked reload decides adoption, not the pre-lock load', () => {
  /** Delegates everything to the real client; `$transaction` waits for release first. */
  function pausingDb() {
    let paused!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => { paused = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (...args: unknown[]) => { paused(); await gate; return (target.$transaction as any)(...args); };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { db: proxy, reached, release };
  }

  /** The revocation, on its own connection, committed before the paused door resumes. */
  async function revokeOnOwnConnection(userId: string, orgId: string, how: 'demoted' | 'removed') {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const sql = how === 'demoted'
        ? "UPDATE org_members SET role = 'CONTRIBUTOR' WHERE user_id = $1 AND organization_id = $2"
        : 'UPDATE org_members SET deleted_at = now() WHERE user_id = $1 AND organization_id = $2';
      const { rowCount } = await client.query(sql, [userId, orgId]);
      expect(rowCount).toBe(1);
    } finally {
      await client.end();
    }
  }

  /** The three consent-writing doors, all thin resolvers over the one adoptionDoor. */
  const WRITE_DOORS = {
    approveAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, hash: string, ctx: unknown) => M.approveAutomation({}, { ...input, expectedHash: hash }, ctx),
    reAdoptAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, hash: string, ctx: unknown) => M.reAdoptAutomation({}, { ...input, expectedHash: hash }, ctx),
    declineAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, _hash: string, ctx: unknown) => M.declineAutomation({}, input, ctx),
  } as const;

  /** An ADOPTED trigger whose graph has since changed, so every door would write if admitted: approve and
   * re-adopt would rebind to the new hash, decline would revoke. */
  async function adoptedThenChanged(role: 'ADMIN' | 'OWNER') {
    const f = await orgFixture();
    const actor = role === 'ADMIN' ? f.orgAdmin : f.orgOwner;
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: (await f.appOnly('Interleave flow')).id };
    const first = await Q.previewAutomation({}, input, f.ctx(actor));
    expect(await M.approveAutomation({}, { ...input, expectedHash: first.hash }, f.ctx(actor))).toBe(true);
    await db.node.update({ where: { id: first.entryId }, data: { content: 'changed after adoption' } });
    const next = await Q.previewAutomation({}, input, f.ctx(actor));
    expect(next.hash).not.toBe(first.hash);
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.id }, select: { roles: true } });
    expect(user.roles).not.toContain('ADMIN');
    expect(user.roles).not.toContain('OWNER');
    expect(f.app).toMatchObject({ ownerUserId: null, organizationId: f.org.id });
    return { f, actor, input, hash: next.hash as string };
  }

  for (const door of Object.keys(WRITE_DOORS) as Array<keyof typeof WRITE_DOORS>) {
    for (const role of ['ADMIN', 'OWNER'] as const) {
      for (const how of ['demoted', 'removed'] as const) {
        it(`${door}: an org ${role} ${how} between the admitted load and the locked reload is refused, nothing written`, async () => {
          const { f, actor, input, hash } = await adoptedThenChanged(role);
          const before = await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } });
          const events = await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } });
          const pause = pausingDb();
          const order: string[] = [];

          const call = WRITE_DOORS[door](input, hash, { ...f.ctx(actor), db: pause.db }).then(
            (v: unknown) => { order.push('door-returned'); return v; },
            (e: unknown) => { order.push('door-threw'); return e; },
          );
          try {
            await pause.reached;
            order.push('admitted-load-paused');
            await revokeOnOwnConnection(actor.id, f.org.id, how);
            order.push('revocation-committed');
          } finally {
            pause.release();
          }
          const err = await call;

          expect(order).toEqual(['admitted-load-paused', 'revocation-committed', 'door-threw']);
          expect(err).toBeInstanceOf(GraphQLError);
          expect(err).toMatchObject({ message: DENIED, extensions: { code: 'FORBIDDEN' } });
          expect(await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } })).toEqual(before);
          expect(await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } })).toEqual(events);
        });
      }

      it(`${door}: the same paused call by an org ${role} whose role is unchanged writes once (admitted control)`, async () => {
        const { f, actor, input, hash } = await adoptedThenChanged(role);
        const before = await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } });
        const events = await db.automationAdoptionEvent.count({ where: { appId: f.app.id } });
        const pause = pausingDb();

        const call = WRITE_DOORS[door](input, hash, { ...f.ctx(actor), db: pause.db });
        await pause.reached;
        pause.release();

        await expect(call).resolves.toBe(true);
        const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } });
        expect(after.automationPin).not.toEqual(before.automationPin);
        if (door === 'declineAutomation') expect(after.automationPin).toBeNull();
        expect(await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id }, orderBy: { createdAt: 'desc' }, take: 1 })).toEqual([
          expect.objectContaining({ action: door === 'declineAutomation' ? 'REVOKE' : 'APPROVE', actorUserId: actor.id }),
        ]);
        expect(await db.automationAdoptionEvent.count({ where: { appId: f.app.id } })).toBe(events + 1);
      });
    }
  }
});

/**
 * #2580: canAdopt conceals ONLY a FORBIDDEN from the shared tenant gate as its plain who-may refusal; any other fault
 * from the userless (App-only) authority check must escape as itself, so an outage never reads as "you may not".
 * The seam is the org-membership read requireOrgRole makes — the first orgMember read any door reaches
 * (requireAdopterContext and liveApp never read it). A human actor throughout: a run principal never reaches
 * canAdopt (requireAdopterContext refuses it first).
 */
describe('#2580 a non-FORBIDDEN fault from the App-only authority check escapes unchanged', () => {
  /** Delegates everything; `orgMember.findFirst` throws `fault` while armed. */
  function faultingDb(fault: Error) {
    const state = { armed: true, hits: 0 };
    const members = new Proxy(db.orgMember, {
      get(target, prop) {
        if (prop === 'findFirst') {
          return async (...args: unknown[]) => {
            if (state.armed) { state.hits++; throw fault; }
            return (target.findFirst as any)(...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === 'orgMember') return members;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { db: proxy, state };
  }

  /** Every admission surface by name; each reaches canAdopt through load(). */
  const ALL_DOORS = {
    previewAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, ctx: unknown) => Q.previewAutomation({}, input, ctx),
    automationApproval: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, ctx: unknown) => Q.automationApproval({}, input, ctx),
    approveAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, ctx: unknown) => M.approveAutomation({}, { ...input, expectedHash: 'a'.repeat(64) }, ctx),
    declineAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, ctx: unknown) => M.declineAutomation({}, input, ctx),
    reAdoptAutomation: (input: { triggerKind: 'SCHEDULE'; triggerRef: string }, ctx: unknown) => M.reAdoptAutomation({}, { ...input, expectedHash: 'a'.repeat(64) }, ctx),
  } as const;

  async function adoptedTrigger() {
    const f = await orgFixture();
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: (await f.appOnly('Fault flow')).id };
    const pin = await Q.previewAutomation({}, input, f.ctx(f.orgAdmin));
    expect(await M.approveAutomation({}, { ...input, expectedHash: pin.hash }, f.ctx(f.orgAdmin))).toBe(true);
    const before = await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } });
    const events = await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } });
    const unchanged = async () => {
      expect(await db.agentSchedule.findUniqueOrThrow({ where: { id: input.triggerRef } })).toEqual(before);
      expect(await db.automationAdoptionEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } })).toEqual(events);
    };
    return { f, input, unchanged };
  }

  it('the exact injected fault escapes every door, with consent and events unchanged', async () => {
    const { f, input, unchanged } = await adoptedTrigger();
    for (const [door, call] of Object.entries(ALL_DOORS)) {
      const sentinel = new Error(`#2580 injected membership-read fault (${door})`);
      const faulting = faultingDb(sentinel);
      const err = await call(input, { ...f.ctx(f.orgAdmin), db: faulting.db }).catch((e: unknown) => e);
      expect(err, door).toBe(sentinel);
      expect(faulting.state.hits, door).toBe(1);
    }
    await unchanged();
  });

  it('a FORBIDDEN from the same read is concealed as the plain who-may refusal on every door', async () => {
    const { f, input, unchanged } = await adoptedTrigger();
    for (const [door, call] of Object.entries(ALL_DOORS)) {
      const forbidden = new GraphQLError('#2580 injected tenant-gate refusal', { extensions: { code: 'FORBIDDEN' } });
      const faulting = faultingDb(forbidden);
      const err = await call(input, { ...f.ctx(f.orgAdmin), db: faulting.db }).catch((e: unknown) => e);
      expect(err, door).not.toBe(forbidden);
      expect(err, door).toMatchObject({ message: DENIED, extensions: { code: 'FORBIDDEN' } });
    }
    await unchanged();
  });

  it('the same delegating db, disarmed, admits the org ADMIN on every door (admitted control)', async () => {
    const { f, input } = await adoptedTrigger();
    const faulting = faultingDb(new Error('never thrown'));
    faulting.state.armed = false;
    const ctx = { ...f.ctx(f.orgAdmin), db: faulting.db };
    const detail = await Q.automationApproval({}, input, ctx);
    expect(detail.state).toBe('ADOPTED');
    await expect(Q.previewAutomation({}, input, ctx)).resolves.toMatchObject({ hash: detail.hash });
    await expect(M.reAdoptAutomation({}, { ...input, expectedHash: detail.hash }, ctx)).resolves.toBe(true);
    await expect(M.approveAutomation({}, { ...input, expectedHash: detail.hash }, ctx)).resolves.toBe(true);
    await expect(M.declineAutomation({}, input, ctx)).resolves.toBe(true);
    expect(await db.automationAdoptionEvent.count({ where: { appId: f.app.id } })).toBe(4);
    expect(faulting.state.hits).toBe(0);
  });
});
