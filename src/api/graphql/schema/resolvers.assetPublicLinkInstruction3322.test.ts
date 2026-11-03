/**
 * #3322 (S5 of #2483), cor:dmo:050:12 + cor:dmo:060:15, Vera's R9 (#3322 comment): the asset public link on an App
 * memory may be switched by a holder's worker on a validated instruction, through #3307's one shared check, judged on
 * the HOLDER. `App.viewerManages` and the manager post stamp stay person-only (cor:dmo:050:12: no worker carries a
 * right on a headless read or stamp).
 *
 * Records: one `app.credential-act` AgentTeamEvent per admitted instructed toggle that CHANGES the flag, ids only
 * (no asset id), none for a refusal, a no-op toggle or a direct person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { wakeStampsFor } from '../../../lib/tickers/postStamp.js';
import { SHAPE_HADRON_SET_ASSET_PUBLIC_LINK } from '../../../mcp/assetTools.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const AppFields = resolvers.App as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-17' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const answer = async (p: Promise<unknown>) => { try { await p; return { code: 'RESOLVED' }; } catch (e: any) { return { code: e.code ?? e.extensions?.code, message: e.message }; } };
const call = (instruction: unknown, c: Context, enabled: boolean) =>
  M.setAssetPublicLink({}, { assetRef: f.asset, enabled, instruction }, c);
// The transport binds a session's worker as the request actor; a bare ctx is the person.
const toggle = (instruction: unknown = live, c: Context = bound(), enabled = true) => c.sessionId
  ? requestActorStorage.run({ workerId: f.worker.id, agentId: f.agent.id }, () => call(instruction, c, enabled))
  : call(instruction, c, enabled);
const flag = async () => (await db.asset.findUniqueOrThrow({ where: { id: f.asset } })).publicLinkEnabled;
const instructionEvents = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } })
  .then((es) => es.filter((e) => (e.payload as any)?.instruction));
const snapshot = async () => ({
  asset: await db.asset.findUniqueOrThrow({ where: { id: f.asset } }),
  audits: await db.assetPublicLinkAudit.findMany({ orderBy: { id: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
});

beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'pl-holder', roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: 'pl-other', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'PL', urn: 'pl3322.test' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: other.id, role: 'ADMIN' },
  ] });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'pl3322.test:team' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'pl3322.test:agent', name: 'Agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const team = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, organizationId: org.id, urn: 'pl3322.test:space', name: 'space' } });
  const asset = generateId();
  await db.asset.create({ data: { id: asset, memoryId: team.id, filename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: `k-${asset}`, scanStatus: 'CLEAN' } });
  f = { holder, other, org, app, agent, worker, session, team, asset };
});

describe('#3322 asset public link on an instruction', () => {
  it('an owner-role holder\'s instruction is admitted: the flag turns on, attributed to the holder, one record', async () => {
    await toggle();
    expect(await flag()).toBe(true);
    const audit = await db.assetPublicLinkAudit.findMany({ where: { assetId: f.asset } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: f.holder.id, enabled: true, previouslyEnabled: false });
    const es = await instructionEvents();
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ type: 'app.credential-act', actorUserId: f.holder.id, actorWorkerId: f.worker.id });
    expect((es[0]!.payload as any).act).toBe('asset.public-link');
    expect((es[0]!.payload as any).instruction).toEqual(live);
  });
  it('an org ADMIN holder\'s instruction is admitted, and the result matches the holder\'s own', async () => {
    await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
    const viaWorker = await toggle();
    const person = await toggle(null, ctx(), false);
    expect(viaWorker.publicLinkEnabled).toBe(true);
    expect(person.publicLinkEnabled).toBe(false);
    expect(await instructionEvents()).toHaveLength(1);
  });
  it('switching it off on an instruction is admitted and recorded too', async () => {
    await db.asset.update({ where: { id: f.asset }, data: { publicLinkEnabled: true } });
    await toggle(live, bound(), false);
    expect(await flag()).toBe(false);
    expect(await instructionEvents()).toHaveLength(1);
  });
  it('a direct person writes no instruction record', async () => {
    await toggle(null, ctx());
    expect(await flag()).toBe(true);
    expect(await instructionEvents()).toHaveLength(0);
  });
  it('a no-op toggle writes no instruction record', async () => {
    await db.asset.update({ where: { id: f.asset }, data: { publicLinkEnabled: true } });
    await toggle(live, bound(), true);
    expect(await instructionEvents()).toHaveLength(0);
  });
  it('the record is ids only: no asset or memory id', async () => {
    await toggle();
    const [e] = await instructionEvents();
    const text = JSON.stringify(e);
    for (const id of [f.asset, f.team.id]) expect(text).not.toContain(id);
  });
  for (const kind of ['no-instruction', 'host-launch', 'unheld', 'other-holder', 'ended-session', 'retired-worker', 'plain-member', 'impersonation', 'app-key', 'refused-binding', 'ambiguous'] as const) {
    it(`${kind} is refused and writes nothing`, async () => {
      let c = bound(); let claim: unknown = live;
      if (kind === 'no-instruction') claim = null;
      if (kind === 'host-launch') await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
      if (kind === 'unheld' || kind === 'other-holder') await db.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: kind === 'unheld' ? null : f.other.id } });
      if (kind === 'ended-session') await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
      if (kind === 'retired-worker') await db.worker.update({ where: { id: f.worker.id }, data: { retiredAt: new Date() } });
      if (kind === 'plain-member') await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
      if (kind === 'impersonation') c = bound({ impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } } as any);
      if (kind === 'app-key') c = { db, appId: f.app.id, roles: [] } as Context;
      if (kind === 'refused-binding') c = bound({ sessionBindingRefused: true });
      const before = await snapshot();
      const invoke = () => (kind === 'ambiguous' ? call(claim, c, true) : toggle(claim, c));
      const got = await answer(kind === 'ambiguous' ? requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['a', 'b'] }, invoke) : invoke());
      expect(got.code).not.toBe('RESOLVED');
      expect(got.code).toBeDefined();
      expect(await snapshot()).toEqual(before);
    });
  }
  it('a worker actor with no persisted session is refused even with an instruction', async () => {
    const before = await snapshot();
    const got = await answer(requestActorStorage.run({ workerId: f.worker.id, agentId: null }, () => toggle(live, ctx())));
    expect(got.code).not.toBe('RESOLVED');
    expect(await snapshot()).toEqual(before);
  });
  it('a holder who does not manage the App gets that holder\'s own refusal, byte-identical, nothing written', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    const before = await snapshot();
    const worker = await answer(toggle(live, bound()));
    const person = await answer(toggle(null, ctx()));
    expect(worker).toEqual(person);
    expect(worker.code).not.toBe('RESOLVED');
    expect(await snapshot()).toEqual(before);
  });
  it('an instruction naming nothing readable is refused', async () => {
    const before = await snapshot();
    const got = await answer(toggle({ kind: 'TASK', ref: 'hrn:agenttask:pl3322.test:team:nope' }));
    expect(got.code).not.toBe('RESOLVED');
    expect(await snapshot()).toEqual(before);
  });
  it('a session that ends while the call waits on its row lock is refused at the final judgement, nothing written', async () => {
    const before = await snapshot();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE sessions SET ended_at = now() WHERE id = ${f.session.id}`;
      held(); await gate;
    });
    await holding;
    const call = answer(toggle());
    try {
      // PostgreSQL itself reports a backend parked on a lock held by the blocker: the call provably reached the session row.
      let waiters = 0;
      for (let i = 0; i < 100 && waiters === 0; i++) {
        const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
            AND query ILIKE '%sessions%'`;
        waiters = Number(n);
        if (waiters === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiters).toBeGreaterThan(0);
    } finally {
      release();
      await Promise.allSettled([blocker, call]);
    }
    expect((await call).code).not.toBe('RESOLVED');
    expect(await flag()).toBe(false);
    expect({ ...(await snapshot()), asset: before.asset }).toEqual(before);
  });
  it('the MCP tool takes the same instruction argument', () => {
    expect(Object.keys(SHAPE_HADRON_SET_ASSET_PUBLIC_LINK)).toContain('instruction');
  });
});

describe('#3322 ask 3 (R9): the nested read and the stamp stay person-only', () => {
  it('App.viewerManages reads true for the manager as a person and false for their worker session', async () => {
    expect(await AppFields.viewerManages({ id: f.app.id }, {}, ctx())).toBe(true);
    const asWorker = await requestActorStorage.run({ workerId: f.worker.id, agentId: f.agent.id }, () => AppFields.viewerManages({ id: f.app.id }, {}, bound()));
    expect(asWorker).toBe(false);
  });
  it('an instructed worker\'s post gets no manager stamp; the manager as a person does', async () => {
    const app = { id: f.app.id, organizationId: f.org.id, ownerUserId: null };
    const stamp = (authorWorkerId: string | null) => db.$transaction((tx) => wakeStampsFor(bound(), tx, app, authorWorkerId, ['all']));
    expect((await stamp(f.worker.id)).managerPost).toBeUndefined();
    expect((await stamp(null)).managerPost).toBe(true);
  });
});
