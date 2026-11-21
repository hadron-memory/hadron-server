/**
 * #3347 (deferred pins from #3342's review seats; Refs #3308). No door behavior changes here: every pin holds
 * behavior that already exists, and each is shown red against a one-site production mutant (see the PR).
 *
 *  1. Each locked grant predicate (name, grantee, App) is isolated with a deterministic transaction boundary: the
 *     unlocked precheck passes on the real grant, then, after the Worker locks, the real grant is revoked and a live
 *     grant that differs in exactly ONE site is put in its place. A locked query that drops that predicate admits the
 *     replacement; the real query refuses. The App site is isolated by the database instead (see its test).
 *  2. A deterministic post-plan change of the cast reporting head is refused, typed and retryable, and writes nothing.
 *  3. The preflight-to-locked Session-principal substitution pins at retire, delete, member add, member remove and
 *     delegated leaveApp (cast and preview are pinned in resolvers.staffMember3308.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-3347' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const answer = async (p: Promise<unknown>) => {
  try { await p; return { code: 'RESOLVED' }; } catch (e: any) { return { code: e.extensions?.code, message: e.message }; }
};
const calls: Record<string, (instruction?: unknown, c?: Context) => Promise<any>> = {
  cast: (instruction, c = bound()) => M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: 'NewWorker', noTeam: true, instruction }, c),
  retire: (instruction, c = bound()) => M.retireWorker({}, { workerRef: f.target.id, instruction }, c),
  delete: (instruction, c = bound()) => M.deleteWorker({}, { workerRef: f.target.id, confirmNoExternalAttribution: true, instruction }, c),
  add: (instruction, c = bound()) => M.ensureAppMember({}, { appRef: f.app.id, userRef: f.other.id, role: 'member', instruction }, c),
  remove: (instruction, c = bound()) => M.removeAppMember({}, { appRef: f.app.id, userRef: f.other.id, instruction }, c),
  preview: (instruction, c = bound()) => Q.castWorkerPreview({}, { appRef: f.app.id, agentRef: f.agent.id, name: 'Preview', noTeam: true, instruction }, c),
  leave: (instruction, c = bound()) => M.leaveApp({}, { appRef: f.app.id, instruction }, c),
};
const snapshot = async () => ({
  workers: await db.worker.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  members: await db.appMember.findMany({ where: { appId: f.app.id }, orderBy: { userId: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  grants: await db.appGrant.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
});
const grantName = (door: string) => (door === 'add' || door === 'remove' || door === 'leave' ? 'APP_MEMBERS' : 'WORKERS_STAFF');
const storedName = (door: string) => (grantName(door) === 'APP_MEMBERS' ? 'app.members' : 'workers.staff');
const give = (door: string, workerId = f.worker.id) => M.grantApp({}, { appRef: f.app.id, workerRef: workerId, name: grantName(door) }, ctx());

beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'pins-holder', roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: 'pins-other', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Pins3347', urn: 'pins3347.test' } });
  await db.orgMember.createMany({ data: [{ organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' }, { organizationId: org.id, userId: other.id, role: 'ADMIN' }] });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'pins3347.test:team' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  f = { holder, other, org, app };
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Current', personaRole: 'server-engineer' }, ctx({ userId: other.id }));
  await db.node.create({ data: { memoryId: agent.systemMemoryId, loc: 'roles', name: 'Roles', nodeType: 'info' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, '{{worker.name}} {{worker.role}}');
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Target', slug: 'target' } });
  // A worker no door acts on, so a grant given to it can only matter through the grantee predicate (never a target-specific refusal).
  const bystander = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Bystander', slug: 'bystander' } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  await db.appMember.create({ data: { appId: app.id, userId: other.id, role: 'reader' } });
  f = { ...f, agent, worker, target, bystander, session };
});

/**
 * A `$transaction` whose callback runs against a tx proxy that fires `hook` once, at a query matching `when`: right after
 * it (`phase: 'after'`) or immediately before it runs (`phase: 'before'`). It intercepts `$queryRaw` only and the patterns match
 * the raw SQL text, so a rewrite of that SQL (or a move to the query builder) makes `fired()` stay false and the pin fail loudly.
 */
function hookQuery(when: RegExp, hook: (tx: any) => Promise<void>, phase: 'before' | 'after' = 'after') {
  let fired = false;
  const client = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return (callback: any, options: any) => db.$transaction(async tx => callback(new Proxy(tx, { get(t, k) {
      if (k === '$queryRaw') return async (query: any, ...values: any[]) => {
        const sql = Array.isArray(query) ? query.join('?') : query.sql;
        const hit = !fired && when.test(sql);
        if (hit && phase === 'before') { fired = true; await hook(t); }
        const value = await (t.$queryRaw as any)(query, ...values);
        if (hit && phase === 'after') { fired = true; await hook(t); }
        return value;
      };
      const value = (t as any)[k]; return typeof value === 'function' ? value.bind(t) : value;
    } })), options);
    const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client, fired: () => fired };
}

describe('#3347 each locked grant predicate is isolated (name, grantee)', () => {
  for (const door of ['cast', 'retire', 'delete', 'add', 'remove', 'preview', 'leave']) {
    for (const site of ['name', 'grantee'] as const) {
      it(`${door}: a live grant differing only in ${site} cannot stand in for the revoked one at the locked check`, async () => {
        await give(door);
        const replacementName = storedName(door) === 'app.members' ? 'workers.staff' : 'app.members';
        const { client, fired } = hookQuery(/FROM app_grants[\s\S]*FOR SHARE/, async (tx) => {
          // The precheck and every unlocked read already passed on the real grant. Immediately before the LOCKED grant read,
          // revoke it and leave exactly one live grant that differs from it in ONE predicate.
          await tx.appGrant.updateMany({ where: { appId: f.app.id, granteeWorkerId: f.worker.id, revokedAt: null }, data: { revokedAt: new Date() } });
          await tx.appGrant.create({ data: {
            appId: f.app.id,
            granteeWorkerId: site === 'grantee' ? f.bystander.id : f.worker.id,
            name: site === 'name' ? replacementName : storedName(door),
            grantedBy: f.holder.id,
          } });
        }, 'before');
        const before = await snapshot();
        expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('FORBIDDEN');
        expect(fired()).toBe(true);
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it('the App site is isolated by the database: a grant cannot name a worker of another App', async () => {
    // The locked query also filters app_id. A grant for THIS worker in another App cannot exist: the same-App trigger
    // (trg_app_grants_same_app, constraint chk_app_grants_same_app) refuses it, so a one-site mutant dropping only that
    // filter has no row to be fooled by. (app_grants_live_uniq is a different guard: one live grant per App, grantee and name.)
    const otherApp = await db.app.create({ data: { organizationId: f.org.id, name: 'Elsewhere', urn: 'pins3347.test:elsewhere' } });
    await expect(db.appGrant.create({ data: { appId: otherApp.id, granteeWorkerId: f.worker.id, name: 'workers.staff', grantedBy: f.holder.id } }))
      .rejects.toThrow(/is not in the App|chk_app_grants_same_app/);
    expect(await db.appGrant.count({ where: { appId: otherApp.id } })).toBe(0);
    // positive control: the same row in the worker's OWN App is accepted, so the refusal above is the App site, not the shape
    await db.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.worker.id, name: 'workers.staff', grantedBy: f.holder.id } });
    expect(await db.appGrant.count({ where: { appId: f.app.id, granteeWorkerId: f.worker.id } })).toBe(1);
  });
});

describe('#3347 the cast reporting head drifting after the plan is refused', () => {
  it('a reportsTo name that resolves to another worker after the plan is CAST_TARGET_CHANGED, retryable, and writes nothing', async () => {
    const mk = (name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name, slug: name.toLowerCase() } });
    const planned = await mk('Head');
    const stranger = await mk('Stranger');
    // The hooked step is castWorker's deciding-membership lock (`app_members ... FOR SHARE`, resolvers.worker.ts ~1049). It is taken
    // after the plan and BEFORE resolveCastTarget re-resolves the reporting head on the locked transaction (~1081), so a change made
    // right after it is exactly the 'post-plan' change; if the order moves, `fired()` or the CAST_TARGET_CHANGED assertion fails.
    const { client, fired } = hookQuery(/FROM app_members[\s\S]*FOR SHARE/, async (tx) => {
      // Post-plan, inside the locked transaction: the name now resolves to a different worker.
      await tx.worker.update({ where: { id: planned.id }, data: { name: 'HeadOld', slug: 'headold' } });
      await tx.worker.update({ where: { id: stranger.id }, data: { name: 'Head', slug: 'head' } });
    });
    const before = await snapshot();
    const a = await M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: 'Casted', reportsTo: 'Head' }, ctx({ db: client })).then(() => null, (e: any) => e);
    expect(fired()).toBe(true);
    expect(a?.extensions).toMatchObject({ code: 'CAST_TARGET_CHANGED', retryable: true });
    // nothing written: the refused cast rolled the whole transaction back, the hook's own renames included, so the
    // workers (and so the reporting graph), the events and the grants are exactly as they were
    expect(await snapshot()).toEqual(before);
    expect(await db.worker.count({ where: { name: 'Casted' } })).toBe(0);
  });
});

describe('#3347 preflight-to-locked Session-principal substitution (the doors cast and preview already pin)', () => {
  // The Session's worker is swapped to a THIRD worker (same holder, its own matching grant) before the transaction callback
  // runs. A locked admission that does not compare against the preflight principal would admit the substitute. A third worker,
  // never the act's own target (deleting a worker the Session points at is refused as WORKER_IN_USE for a different reason,
  // before the principal comparison this pin is about).
  const setup = async (door: string, substitute: boolean) => {
    const third = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name: 'Third', slug: 'third', heldByUserId: f.holder.id } });
    await give(door); await give(door, third.id);
    let swapped = false;
    const client = new Proxy(db, { get(target, key) {
      if (key === '$transaction') return (callback: any, options: any) => db.$transaction(async tx => {
        if (substitute) { await tx.session.update({ where: { id: f.session.id }, data: { workerId: third.id } }); swapped = true; }
        return callback(tx);
      }, options);
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { client, swapped: () => swapped };
  };
  for (const door of ['retire', 'delete', 'add', 'remove', 'leave']) {
    // The positive control: the same fixture and the same two grants, with NO substitution, is admitted. So the refusal below
    // is the principal comparison, not an earlier refusal for another reason (a sole owner leaving, a missing grant, ...).
    it(`${door}: control without the substitution is admitted`, async () => {
      const { client, swapped } = await setup(door, false);
      expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('RESOLVED');
      expect(swapped()).toBe(false);
    });
    it(`${door}: a transaction-local Session substitution cannot replace the preflight worker`, async () => {
      const { client, swapped } = await setup(door, true);
      const before = await snapshot();
      expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('FORBIDDEN');
      expect(swapped()).toBe(true); // the substitution really happened inside the transaction the door ran
      expect(await snapshot()).toEqual(before);
    });
  }
});
