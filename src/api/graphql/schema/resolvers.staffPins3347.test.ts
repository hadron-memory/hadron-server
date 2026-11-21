/**
 * #3347 (deferred pins from #3342's review seats; Refs #3308). No door behavior changes here: every pin holds
 * behavior that already exists, and each is shown red against a one-site production mutant (see the PR).
 *
 *  1. Each locked grant predicate (name, grantee, App) is isolated with a deterministic transaction boundary: the
 *     unlocked precheck passes on the real grant, then, after the Worker locks, the real grant is revoked and a live
 *     grant that differs in exactly ONE site is put in its place. A locked query that drops that predicate admits the
 *     replacement; the real query refuses. The App site is isolated by the database instead (see its test).
 *  2. A deterministic post-plan change of the cast reporting head is refused, typed and retryable, and writes nothing.
 *  3. The preflight-to-locked Session-principal substitution pins at retire, delete, deleteWorkerPreview, member add, member
 *     remove and delegated leaveApp (cast and preview are pinned in resolvers.staffMember3308.test.ts).
 *
 * #4740 (polish of the above, test-only): deleteWorkerPreview joins both matrices; the substitution pins assert the door's own
 * refusal (code AND text), that the swap happened in the one transaction the door opened, and, for the control, that the act
 * took effect; the grantee-site pins enforce that no door acts on the bystander; hookQuery matches one statement only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
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
/** What a door answered: `RESOLVED` with its value (typed `unknown`; the use narrows by asserting its shape), or the refusal's code and text. */
type Answer = { code: string | undefined; message?: string; value?: unknown };
const answer = async (p: Promise<unknown>): Promise<Answer> => {
  try { const value = await p; return { code: 'RESOLVED', value }; } catch (e: any) { return { code: e.extensions?.code, message: e.message }; }
};
/** The names and the target the doors use, defined ONCE: `calls` below and the `actsOn` precondition both read these, so the table cannot drift from the calls (#4740 F5). */
const CAST_NAME = 'NewWorker';
const PREVIEW_NAME = 'Preview';
const DRIFT_NAME = 'Casted'; // the cast-drift test's own cast, which is not a matrix door but must not be the bystander either
const targetId = (): string => f.target.id;
/** Every door either matrix runs, and the six the substitution matrix runs (cast and preview pin theirs in resolvers.staffMember3308.test.ts).
 *  The per-door tables below are keyed by these unions, so a door added without its entry, or a typo, is a compile error (#4740 F3). */
const DOORS = ['cast', 'retire', 'delete', 'deletePreview', 'add', 'remove', 'preview', 'leave'] as const;
type Door = (typeof DOORS)[number];
const SUBSTITUTION_DOORS = ['retire', 'delete', 'deletePreview', 'add', 'remove', 'leave'] as const;
type SubstitutionDoor = (typeof SUBSTITUTION_DOORS)[number];
const calls: Record<Door, (instruction?: unknown, c?: Context) => Promise<any>> = {
  cast: (instruction, c = bound()) => M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: CAST_NAME, noTeam: true, instruction }, c),
  retire: (instruction, c = bound()) => M.retireWorker({}, { workerRef: targetId(), instruction }, c),
  delete: (instruction, c = bound()) => M.deleteWorker({}, { workerRef: targetId(), confirmNoExternalAttribution: true, instruction }, c),
  add: (instruction, c = bound()) => M.ensureAppMember({}, { appRef: f.app.id, userRef: f.other.id, role: 'member', instruction }, c),
  remove: (instruction, c = bound()) => M.removeAppMember({}, { appRef: f.app.id, userRef: f.other.id, instruction }, c),
  preview: (instruction, c = bound()) => Q.castWorkerPreview({}, { appRef: f.app.id, agentRef: f.agent.id, name: PREVIEW_NAME, noTeam: true, instruction }, c),
  leave: (instruction, c = bound()) => M.leaveApp({}, { appRef: f.app.id, instruction }, c),
  deletePreview: (instruction, c = bound()) => Q.deleteWorkerPreview({}, { workerRef: targetId(), instruction }, c),
};
const snapshot = async () => ({
  workers: await db.worker.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  members: await db.appMember.findMany({ where: { appId: f.app.id }, orderBy: { userId: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  grants: await db.appGrant.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
});
/** The events `after` has that `before` did not, by id (never by position: ids are UUIDv7, time-ordered only to the millisecond). */
const createdSince = <T extends { id: string }>(before: T[], after: T[]): T[] => {
  const known = new Set(before.map((e) => e.id));
  return after.filter((e) => !known.has(e.id));
};
const grantName = (door: Door) => (door === 'add' || door === 'remove' || door === 'leave' ? 'APP_MEMBERS' : 'WORKERS_STAFF');
const storedName = (door: Door) => (grantName(door) === 'APP_MEMBERS' ? 'app.members' : 'workers.staff');
const give = (door: Door, workerId = f.worker.id) => M.grantApp({}, { appRef: f.app.id, workerRef: workerId, name: grantName(door) }, ctx());
/**
 * What each door acts on, by KIND (#4740 N7, F1). The grantee-site pins put a live grant on the BYSTANDER, a worker, and read a refusal
 * as the grantee predicate alone; that holds only while no door names that worker. A door names a worker by id (retire, delete,
 * deletePreview) or by NAME (cast, preview mint one), or acts on USERS (add, remove, leave), which can never be the bystander worker,
 * so for those three the guard is the OBSERVED one in every test: the bystander's row is unchanged and no new event names it.
 */
type Acts = { workerIds: string[]; workerNames: string[]; userIds: string[] };
const actsOn = (door: Door): Acts => {
  const none: Acts = { workerIds: [], workerNames: [], userIds: [] };
  const table: Record<Door, Acts> = {
    cast: { ...none, workerNames: [CAST_NAME, DRIFT_NAME] }, preview: { ...none, workerNames: [PREVIEW_NAME] },
    retire: { ...none, workerIds: [targetId()] }, delete: { ...none, workerIds: [targetId()] }, deletePreview: { ...none, workerIds: [targetId()] },
    add: { ...none, userIds: [f.other.id] }, remove: { ...none, userIds: [f.other.id] }, leave: { ...none, userIds: [f.holder.id] },
  };
  return table[door];
};
/** The precondition, per kind: no worker id and no worker name a door uses is the bystander's. */
const expectBystanderUntargeted = (door: Door) => {
  const acts = actsOn(door);
  expect(acts.workerIds, `${door} names no worker id of the bystander`).not.toContain(f.bystander.id);
  expect(acts.workerNames, `${door} names no worker called like the bystander`).not.toContain(f.bystander.name);
};
/** Pairwise distinct, with the colliding ids in the message. */
const expectDistinct = (what: string, ids: string[]) => expect(new Set(ids).size, `${what} must be pairwise distinct: ${ids.join(', ')}`).toBe(ids.length);
const bystanderRow = () => db.worker.findUniqueOrThrow({ where: { id: f.bystander.id } });

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
 * True only when `sql` is ONE statement that matches `when`. A joined multi-statement string (a `;` with more SQL after it, or any
 * inner `;`) never matches, so a pattern with `[\s\S]*` cannot be satisfied by a SECOND statement of a batch; a query that really
 * has an inner `;` makes `fired()` stay false and the pin fail loudly (#4740 F2). Values are bound parameters, never in this text.
 */
const singleStatementMatches = (when: RegExp, sql: string): boolean => {
  const body = sql.trim().replace(/;\s*$/, '');
  return !body.includes(';') && when.test(body);
};

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
        const hit = !fired && singleStatementMatches(when, sql);
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
  for (const door of DOORS) {
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
        const bystander = await bystanderRow();
        expectBystanderUntargeted(door);
        expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('FORBIDDEN');
        expect(fired()).toBe(true);
        expect(await snapshot()).toEqual(before);
        expect(await bystanderRow()).toEqual(bystander);
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
    // The hooked step is castWorker's deciding-membership lock (the `app_members ... FOR SHARE` read inside its transaction). It is
    // taken after the plan and BEFORE `resolveCastTarget` re-resolves the reporting head on the locked transaction, so a change made
    // right after it is exactly the 'post-plan' change; if that order moves, `fired()` or the CAST_TARGET_CHANGED assertion fails.
    const { client, fired } = hookQuery(/FROM app_members[\s\S]*FOR SHARE/, async (tx) => {
      // Post-plan, inside the locked transaction: the name now resolves to a different worker.
      await tx.worker.update({ where: { id: planned.id }, data: { name: 'HeadOld', slug: 'headold' } });
      await tx.worker.update({ where: { id: stranger.id }, data: { name: 'Head', slug: 'head' } });
    });
    const before = await snapshot();
    const a = await M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: DRIFT_NAME, reportsTo: 'Head' }, ctx({ db: client })).then(() => null, (e: any) => e);
    expect(fired()).toBe(true);
    expect(a?.extensions).toMatchObject({ code: 'CAST_TARGET_CHANGED', retryable: true });
    // nothing written: the refused cast rolled the whole transaction back, the hook's own renames included, so the
    // workers (and so the reporting graph), the events and the grants are exactly as they were
    expect(await snapshot()).toEqual(before);
    expect(await db.worker.count({ where: { name: DRIFT_NAME } })).toBe(0);
  });
});

describe('#3347 preflight-to-locked Session-principal substitution (the doors cast and preview already pin)', () => {
  // The Session's worker is swapped to a THIRD worker (same holder, its own matching grant) before the transaction callback
  // runs. A locked admission that does not compare against the preflight principal would admit the substitute. A third worker,
  // never the act's own target (deleting a worker the Session points at is refused as WORKER_IN_USE for a different reason,
  // before the principal comparison this pin is about).
  //
  // #4740 N3: the swap is recorded BY TRANSACTION, not as a boolean. `opened()` counts the transactions the door opened through the
  // client and `swappedAt()` lists which of them (1-based) had the Session swapped, so a door that opened a second transaction, or a
  // swap that landed in the wrong one, shows in the assertion instead of reading as "swapped".
  const setup = async (door: SubstitutionDoor, substitute: boolean) => {
    const third = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name: 'Third', slug: 'third', heldByUserId: f.holder.id } });
    // the substitute is a worker of its own: neither the caller, the act's target nor the bystander (#4740 F1)
    expectDistinct('the bystander, the caller, the target and the substitute', [f.bystander.id, f.worker.id, f.target.id, third.id]);
    await give(door); await give(door, third.id);
    let opened = 0;
    const swappedAt: number[] = [];
    const client = new Proxy(db, { get(target, key) {
      if (key === '$transaction') return (callback: any, options: any) => {
        const n = ++opened;
        return db.$transaction(async tx => {
          if (substitute) { await tx.session.update({ where: { id: f.session.id }, data: { workerId: third.id } }); swappedAt.push(n); }
          return callback(tx);
        }, options);
      };
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { client, opened: () => opened, swappedAt: () => [...swappedAt] };
  };
  // #4740 N1: the refusal the door answers for a swapped principal, code AND text, so another Session-sensitive check cannot satisfy
  // the pin with a bare FORBIDDEN. The worker doors share one text; the two member-removal doors share another (cor:agt:020:00 pins
  // only that the excluded caller is refused with nothing changed; the wording is the door's own).
  const WORKERS = 'You are not authorized to manage workers in this App.';
  const REMOVAL = 'Forbidden: only org admins, App owners, or the user themselves can remove members';
  const refusal: Record<SubstitutionDoor, string> = {
    retire: WORKERS, delete: WORKERS, deletePreview: WORKERS,
    add: 'Forbidden: only org admins or App owners can manage members', remove: REMOVAL, leave: REMOVAL,
  };
  // #4740 N2: what each control's act did, as a before/after diff of the App's rows (not only RESOLVED). `deletePreview` writes
  // nothing and returns its attestation payload; the others change exactly the rows named here.
  const tookEffect = (door: SubstitutionDoor, before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>, value: unknown) => {
    // a missing row fails with its name, not a bare TypeError on a `!` (#4740 F6)
    const must = <T,>(row: T | undefined, what: string): T => { expect(row, what).toBeDefined(); return row as T; };
    const worker = (rows: typeof before.workers, id: string) => rows.find((w: any) => w.id === id);
    const member = (rows: typeof before.members, id: string) => rows.find((m: any) => m.userId === id);
    const others = <T,>(rows: T[], idOf: (row: T) => string, skip: string) => rows.filter((row) => idOf(row) !== skip);
    expect(after.events.length, `${door}: one staffing event recorded`).toBe(door === 'deletePreview' ? before.events.length : before.events.length + 1);
    if (door === 'retire') {
      expect(must(worker(before.workers, f.target.id), 'the target before').retiredAt).toBeNull();
      expect(must(worker(after.workers, f.target.id), 'the target after').retiredAt).not.toBeNull();
      expect(others(after.workers, (w) => w.id, f.target.id)).toEqual(others(before.workers, (w) => w.id, f.target.id));
    } else if (door === 'delete') {
      expect(after.workers).toEqual(others(before.workers, (w) => w.id, f.target.id)); // only the target is gone, nothing else moved
    } else if (door === 'deletePreview') {
      expect(value).toEqual({ workerId: f.target.id, attestationRequired: true });
      expect(after.workers).toEqual(before.workers);
      expect(after.members).toEqual(before.members);
    } else if (door === 'add') {
      expect(must(member(before.members, f.other.id), 'the member before').role).toBe('reader');
      expect(must(member(after.members, f.other.id), 'the member after').role).toBe('member');
      expect(others(after.members, (m) => m.userId, f.other.id)).toEqual(others(before.members, (m) => m.userId, f.other.id)); // no other member row moved
      expect(after.workers).toEqual(before.workers); // and no worker row
    } else if (door === 'remove') {
      expect(member(after.members, f.other.id)).toBeUndefined();
      expect(after.members).toEqual(others(before.members, (m) => m.userId, f.other.id));
    } else {
      expect(member(after.members, f.holder.id)).toBeUndefined();
      expect(after.members).toEqual(others(before.members, (m) => m.userId, f.holder.id));
    }
    // #4740 F3: every collection the door does not own is exactly as it was, so a cross-collection side effect cannot pass.
    const owns: Record<SubstitutionDoor, Array<keyof typeof before>> = {
      retire: ['workers', 'events'], delete: ['workers', 'events'], deletePreview: [],
      add: ['members', 'events'], remove: ['members', 'events'], leave: ['members', 'events'],
    };
    for (const key of ['workers', 'members', 'events', 'grants'] as const) {
      if (!owns[door].includes(key)) expect(after[key], `${door} left ${key} untouched`).toEqual(before[key]);
    }
  };
  for (const door of SUBSTITUTION_DOORS) {
    // The positive control: the same fixture and the same two grants, with NO substitution, is admitted. So the refusal below
    // is the principal comparison, not an earlier refusal for another reason (a sole owner leaving, a missing grant, ...).
    it(`${door}: control without the substitution is admitted and its act took effect`, async () => {
      const { client, opened, swappedAt } = await setup(door, false);
      const before = await snapshot();
      const bystander = await bystanderRow();
      expectBystanderUntargeted(door);
      const result = await answer(calls[door](undefined, bound({ db: client })));
      expect(result.code).toBe('RESOLVED');
      expect(opened()).toBe(1);
      expect(swappedAt()).toEqual([]);
      const after = await snapshot();
      tookEffect(door, before, after, result.value);
      // N7, observed: whatever the door did, it did nothing to the bystander (its row) and wrote no event that names it.
      expect(await bystanderRow()).toEqual(bystander);
      // New events by SET DIFFERENCE on ids: generateId is a UUIDv7 (time-ordered only to the millisecond, a random tail within one), so
      // `slice(before.length)` could swap an old event in for a new one. The ids are 32 hex characters, so none is a substring of another.
      const created = createdSince(before.events, after.events);
      expect(created, `${door} recorded ${door === 'deletePreview' ? 'no' : 'exactly one'} staffing event`).toHaveLength(door === 'deletePreview' ? 0 : 1);
      expect(JSON.stringify(created)).not.toContain(f.bystander.id);
    });
    it(`${door}: a transaction-local Session substitution cannot replace the preflight worker`, async () => {
      const { client, opened, swappedAt } = await setup(door, true);
      const before = await snapshot();
      const bystander = await bystanderRow();
      const result = await answer(calls[door](undefined, bound({ db: client })));
      expect(result).toEqual({ code: 'FORBIDDEN', message: refusal[door] });
      expect(opened()).toBe(1); // the one transaction the door opened ...
      expect(swappedAt()).toEqual([1]); // ... is the one the substitution happened in
      expect(await snapshot()).toEqual(before);
      expect(await bystanderRow()).toEqual(bystander);
    });
  }
});

// #4740 F2: the matcher hookQuery uses is itself pinned, so a loosening (back to a bare `when.test(sql)`) turns a test red here.
describe('#4740 hookQuery matches one statement, never a batch', () => {
  const grants = /FROM app_grants[\s\S]*FOR SHARE/;
  it('matches a single statement, with or without a trailing semicolon', () => {
    expect(singleStatementMatches(grants, 'SELECT id FROM app_grants WHERE app_id = $1 FOR SHARE')).toBe(true);
    expect(singleStatementMatches(grants, 'SELECT id FROM app_grants WHERE app_id = $1 FOR SHARE;\n')).toBe(true);
  });
  it('does not match a batch whose SECOND statement is the one the pattern describes', () => {
    expect(singleStatementMatches(grants, 'SELECT 1; SELECT id FROM app_grants WHERE app_id = $1 FOR SHARE')).toBe(false);
  });
  it('does not match a batch whose FIRST statement is the one the pattern describes (fail loudly, not by luck)', () => {
    expect(singleStatementMatches(grants, 'SELECT id FROM app_grants WHERE app_id = $1 FOR SHARE; SELECT 1')).toBe(false);
  });
  it('does not match a single statement that is not the described one', () => {
    expect(singleStatementMatches(grants, 'SELECT id FROM app_members WHERE app_id = $1 FOR SHARE')).toBe(false);
  });
  it('hookQuery itself leaves its hook unfired on a batch, and fires it on the single statement', async () => {
    // phase 'before' sets fired() and runs the hook before the query reaches Postgres, so the batch's own failure (a prepared
    // statement cannot hold two commands) cannot hide a hook that should not have fired.
    const batch = hookQuery(grants, async () => undefined, 'before');
    await batch.client.$transaction(async (tx: any) => { await tx.$queryRaw(Prisma.sql`SELECT 1; SELECT id FROM app_grants FOR SHARE`).catch(() => undefined); }).catch(() => undefined);
    expect(batch.fired()).toBe(false);
    const single = hookQuery(grants, async () => undefined, 'before');
    await single.client.$transaction(async (tx: any) => { await tx.$queryRaw(Prisma.sql`SELECT id FROM app_grants FOR SHARE`); });
    expect(single.fired()).toBe(true);
  });
});

// #4740 F1: the new-events computation is by id, so an OLD event that sorts after a NEW one (ids tie to the millisecond) cannot stand in for it.
describe('#4740 createdSince finds new events by id, not by position', () => {
  it('picks the new event even when it sorts BEFORE an old one, where a slice by count picks the old one', () => {
    const before = [{ id: 'b-old' }];
    const after = [{ id: 'a-new' }, { id: 'b-old' }]; // ordered by id: the new event sorts first
    expect(after.slice(before.length)).toEqual([{ id: 'b-old' }]); // the position-based reading would inspect the wrong event
    expect(createdSince(before, after)).toEqual([{ id: 'a-new' }]);
  });
  it('is empty when nothing was created, and returns every new event when several were', () => {
    expect(createdSince([{ id: 'x' }], [{ id: 'x' }])).toEqual([]);
    expect(createdSince([{ id: 'x' }], [{ id: 'm' }, { id: 'x' }, { id: 'z' }])).toEqual([{ id: 'm' }, { id: 'z' }]);
  });
});

// #4740 N7, F1: what the precondition can and cannot say. The bystander is a WORKER; the doors that name workers (by id or by name) are
// checked per kind here and in every matrix test, the doors that act on users are guarded by the observed checks in those tests.
describe('#4740 the bystander is not acted on by any door', () => {
  it('no door names the bystander worker by id or by name, and the caller, target and bystander are distinct workers', () => {
    for (const door of DOORS) expectBystanderUntargeted(door);
    expectDistinct('the bystander, the caller and the target', [f.bystander.id, f.worker.id, f.target.id]);
    expect(f.session.workerId, 'the Session is the caller\'s').toBe(f.worker.id);
    // every worker name a door mints is checked above; the bystander's own name is not one of them
    const minted = DOORS.flatMap((door) => actsOn(door).workerNames);
    expect(minted.length).toBeGreaterThan(0);
    expect(minted).not.toContain(f.bystander.name);
  });
});
