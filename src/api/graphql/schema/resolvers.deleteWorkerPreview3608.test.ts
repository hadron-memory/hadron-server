/**
 * #3608: the preview's admission and lock prologue match the real delete, and an instructed preview
 * that loses the race to the delete answers WORKER_NOT_FOUND in either winner order
 * (hrn:node:hadronmemory.com:specs:cor:dmo:050:11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const anchorRequests = vi.hoisted(() => [] as Array<{ anchors: unknown; mode: string }>);
vi.mock('../../../lib/auth/authorityAnchors.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../../lib/auth/authorityAnchors.js')>();
  return { ...real, lockAuthorityAnchors: async (tx: any, anchors: any, mode: any) => {
    anchorRequests.push({ anchors, mode });
    return real.lockAuthorityAnchors(tx, anchors, mode);
  } };
});
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const instruction = { kind: 'LIVE_CHAT', ref: 'client-chat:preview3608' };
const passed = (id: string) => ({ workerId: id, attestationRequired: true });
let f: any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const preview = (c: Context = ctx(), workerRef: string = f.target.id, claim?: unknown) => Q.deleteWorkerPreview({}, { workerRef, instruction: claim }, c);
const remove = (workerRef: string = f.target.id, c: Context = ctx(), claim?: unknown) =>
  M.deleteWorker({}, { workerRef, confirmNoExternalAttribution: true, instruction: claim }, c);
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) {
    if (!e.extensions) throw e;
    return { message: e.message, extensions: e.extensions };
  }
  throw new Error('expected a refusal');
}
const claims = () => db.agentTeamEvent.count({ where: { appId: f.app.id, type: 'worker.instruction-claimed' } });
const deletions = () => db.agentTeamEvent.count({ where: { appId: f.app.id, type: 'worker.deleted' } });
const state = async () => ({
  workers: await db.worker.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  sessions: await db.session.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
  fences: await db.$queryRaw`SELECT subject_id, version FROM worker_reference_fences ORDER BY subject_id`,
});
/** The real client, with `run` invoked once on the transaction just before the named write or census read. */
function interruptAt(point: 'census' | 'claim', run: () => Promise<void>) {
  let done = false;
  const once = async () => { if (!done) { done = true; await run(); } };
  const hook = (model: any, method: string, match: (args: any) => boolean) => new Proxy(model, { get(target, key) {
    if (key === method) return async (args: any) => { if (match(args)) await once(); return target[method](args); };
    const value = target[key as string]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const client = new Proxy(db, { get(object, key) {
    if (key === '$transaction') return (callback: any, options: any) => object.$transaction(tx => callback(new Proxy(tx, { get(transaction, modelKey) {
      if (point === 'census' && modelKey === 'worker') return hook(transaction.worker, 'findUnique', args => args.where?.id === f.target.id);
      if (point === 'claim' && modelKey === 'agentTeamEvent') return hook(transaction.agentTeamEvent, 'create', args => args.data.type === 'worker.instruction-claimed');
      const value = (transaction as any)[modelKey]; return typeof value === 'function' ? value.bind(transaction) : value;
    } })), options);
    const value = (object as any)[key]; return typeof value === 'function' ? value.bind(object) : value;
  } });
  return { client: client as typeof db, fired: () => done };
}
/** Counts the transactions a door opens. */
function countingTransactions() {
  let opened = 0;
  const client = new Proxy(db, { get(object, key) {
    if (key === '$transaction') return (callback: any, options: any) => { opened++; return object.$transaction(callback, options); };
    const value = (object as any)[key]; return typeof value === 'function' ? value.bind(object) : value;
  } });
  return { client: client as typeof db, opened: () => opened };
}
/** A client whose transactions give up on a held lock instead of waiting for it. */
const impatient = new Proxy(db, { get(object, key) {
  if (key === '$transaction') return (callback: any, options: any) => object.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
    return callback(tx);
  }, options);
  const value = (object as any)[key]; return typeof value === 'function' ? value.bind(object) : value;
} }) as typeof db;
/** Runs `attempt` while another transaction holds what `hold` takes. */
async function whileHeld(hold: (tx: any) => Promise<unknown>, attempt: () => Promise<unknown>) {
  let release!: () => void; let held!: () => void;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const holder = db.$transaction(async tx => { await hold(tx); held(); await released; }, { timeout: 15000 });
  await ready;
  try { return await attempt().then(value => ({ value }), (error: any) => ({ error })); }
  finally { release(); await holder; }
}
const blockedByLock = (outcome: any) => expect(String(outcome.error?.message ?? outcome.error?.meta?.message ?? outcome.error)).toMatch(/55P03|lock timeout|canceling statement/i);

beforeEach(async () => {
  await cleanDb(db);
  const key = generateId().toLowerCase();
  const holder = await db.user.create({ data: { handle: `holder-${key}`, roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Preview', urn: `p3608-${key}.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  f = { holder, org, app };
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Role', personaRole: 'server-engineer' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const caller = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: caller.id, userId: holder.id, tool: 'vitest' } });
  const target = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Miscast' }, ctx());
  f = { ...f, agent, caller, session, target };
});
afterEach(() => sessionKeyCache.clear());

describe('#3608 item 3: the delete wins the race', () => {
  const gone = (workerRef: string) => ({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef } });

  it('both winner orders give the same refusal, echo the caller\'s input and leave no claim', async () => {
    const urn = `hrn:worker:${f.app.urn}:${f.target.slug}`;
    const first = interruptAt('census', async () => { expect(await remove()).toBe(true); });
    const beforeCensus = await refusal(preview(bound({ db: first.client }), urn, instruction));
    expect(first.fired()).toBe(true);
    expect(beforeCensus).toEqual(gone(urn));
    expect(await claims()).toBe(0);
    expect(await deletions()).toBe(1);

    const again = await M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: 'Second' }, ctx());
    f.target = again;
    const urn2 = `hrn:worker:${f.app.urn}:${again.slug}`;
    const second = interruptAt('claim', async () => { expect(await remove()).toBe(true); });
    const beforeClaim = await refusal(preview(bound({ db: second.client }), urn2, instruction));
    expect(second.fired()).toBe(true);
    expect(beforeClaim).toEqual(gone(urn2));
    expect(await claims()).toBe(0);
    expect(await deletions()).toBe(2);
  });

  it('the claim-time refusal carries nothing of the fence', async () => {
    const race = interruptAt('claim', async () => { expect(await remove()).toBe(true); });
    const got = await refusal(preview(bound({ db: race.client }), f.target.id, instruction));
    expect(Object.keys(got.extensions).sort()).toEqual(['code', 'workerRef']);
    expect(JSON.stringify(got)).not.toMatch(/agent_team_events|referenceRef|referenceKind|writer/);
  });

  it('a fence naming the ACTOR keeps its refusal: the target is still there', async () => {
    // The actor's own rows are locked by the preview, so a concurrent delete cannot reach it here.
    // Naming a missing actor on the claim makes the same fence fire on the other reference.
    const ghost = generateId();
    const client = new Proxy(db, { get(object, key) {
      if (key === '$transaction') return (callback: any, options: any) => object.$transaction(tx => callback(new Proxy(tx, { get(transaction, modelKey) {
        if (modelKey === 'agentTeamEvent') return new Proxy(transaction.agentTeamEvent, { get(model, method) {
          if (method === 'create') return (args: any) => model.create({ ...args, data: { ...args.data, actorWorkerId: ghost } });
          const value = (model as any)[method]; return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = (transaction as any)[modelKey]; return typeof value === 'function' ? value.bind(transaction) : value;
      } })), options);
      const value = (object as any)[key]; return typeof value === 'function' ? value.bind(object) : value;
    } }) as typeof db;
    const got = await refusal(preview(bound({ db: client }), f.target.id, instruction));
    expect(got.extensions).toMatchObject({ code: 'WORKER_REFERENCE_NOT_FOUND', referenceKind: 'worker', referenceRef: ghost, workerRef: ghost });
    expect(await db.worker.findUnique({ where: { id: f.target.id } })).not.toBeNull();
    expect(await claims()).toBe(0);
  });
});

describe('#3608 items 1 and 2: the prologue matches the real delete', () => {
  it('a refused caller opens no transaction, so it reaches no anchor lock', async () => {
    const run = countingTransactions();
    const c = ctx({ db: run.client, clientId: 'run:preview3608', appId: f.app.id });
    const got = await refusal(preview(c));
    expect(got.extensions.code).toBe('FORBIDDEN');
    expect(run.opened()).toBe(0);
    const person = countingTransactions();
    expect(await preview(ctx({ db: person.client }))).toEqual(passed(f.target.id));
    expect(person.opened()).toBe(1);
  });

  it('holds the App row FOR SHARE, as the real delete does', async () => {
    const hold = (tx: any) => tx.$queryRaw`SELECT id FROM apps WHERE id = ${f.app.id} FOR UPDATE`;
    blockedByLock(await whileHeld(hold, () => preview(ctx({ db: impatient }))));
    blockedByLock(await whileHeld(hold, () => remove(f.target.id, ctx({ db: impatient }))));
    expect(await preview(ctx({ db: impatient }))).toEqual(passed(f.target.id));
  });

  // Only the owner can be admitted to a user-owned App, so at the database this anchor is the caller's
  // own. What can differ is the request, so the pin compares what each door asks for.
  it('requests the same anchors as the real delete, including the owner-user anchor', async () => {
    const key = generateId().toLowerCase();
    const owner = await db.user.create({ data: { handle: `owner-${key}`, roles: ['READER'] } });
    const app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Mine', urn: `${owner.handle}.test:mine` } });
    const agent = await db.agent.create({ data: { ownerUserId: owner.id, name: 'Mine', personaRole: 'server-engineer', urn: `${owner.handle}.test:agent` } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const c: Context = { db, userId: owner.id, roles: ['READER'] };
    const target = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Miscast' }, c);
    anchorRequests.length = 0;
    expect(await preview(c, target.id)).toEqual(passed(target.id));
    const previewed = [...anchorRequests];
    anchorRequests.length = 0;
    expect(await remove(target.id, c)).toBe(true);
    expect(previewed).toEqual(anchorRequests);
    expect(previewed).toEqual([{ mode: 'shared', anchors: [{ kind: 'app', id: app.id }, { kind: 'user', id: owner.id }, { kind: 'user', id: owner.id }] }]);
  });
  it('requests the same anchors as the real delete on an org App', async () => {
    anchorRequests.length = 0;
    await preview();
    const previewed = [...anchorRequests];
    anchorRequests.length = 0;
    await remove();
    expect(previewed).toEqual(anchorRequests);
    expect(previewed).toEqual([{ mode: 'shared', anchors: [{ kind: 'app', id: f.app.id }, { kind: 'user', id: f.holder.id }, { kind: 'org', id: f.org.id }] }]);
  });
});

describe('#3608 reference forms and negative controls', () => {
  it('a URN names the same target as its id', async () => {
    const urn = `hrn:worker:${f.app.urn}:${f.target.slug}`;
    expect(await preview(ctx(), urn)).toEqual(passed(f.target.id));
  });
  it.each(['hrn:worker:not-a-real:reference', 'not a reference', ''])('malformed or unknown reference %j refuses exactly as the delete does', async ref => {
    const before = await state();
    const got = await refusal(preview(ctx(), ref));
    expect(got).toEqual(await refusal(remove(ref)));
    expect(got).toEqual({ message: 'Worker not found.', extensions: { code: 'WORKER_NOT_FOUND', workerRef: ref } });
    expect(await state()).toEqual(before);
  });
  it('a malformed instruction refuses exactly as the delete does', async () => {
    const claim = { kind: 'TASK', ref: 'not-a-task' };
    const before = await state();
    const got = await refusal(preview(bound(), f.target.id, claim));
    expect(got).toEqual(await refusal(remove(f.target.id, bound(), claim)));
    expect(got.extensions.code).toBe('FORBIDDEN');
    expect(await state()).toEqual(before);
  });
  it('an instruction from a person with no bound session records no claim', async () => {
    const before = await state();
    expect(await preview(ctx(), f.target.id, instruction)).toEqual(passed(f.target.id));
    expect(await state()).toEqual(before);
  });
  it('the instructing worker cannot preview itself: its live session keeps it in use', async () => {
    const before = await state();
    const got = await refusal(preview(bound(), f.caller.id, instruction));
    expect(got).toEqual(await refusal(remove(f.caller.id, bound(), instruction)));
    expect(got.extensions).toEqual({ code: 'WORKER_IN_USE', workerId: f.caller.id });
    expect(await state()).toEqual(before);
  });
});
