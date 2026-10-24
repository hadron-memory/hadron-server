/** #2024 (S8): Agent ticker templates, cast-time instantiation, retirement and the miscast-repair carve-out. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { lockAgentTemplates } from '../../../lib/tickers/agentTickerTemplates.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let ctx: Context;
let outsider: Context;
let managerOnly: Context;
let orgId: string;
let appId: string;
let agentId: string;

const asUser = (userId: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Tmpl', urn: 'tmpl2024.com' } });
  orgId = org.id;
  const admin = await db.user.create({ data: { id: generateId(), githubId: 202400, githubUsername: 'tmpl-admin' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  ctx = asUser(admin.id);
  const other = await db.user.create({ data: { id: generateId(), githubId: 202401, githubUsername: 'tmpl-outsider' } });
  outsider = asUser(other.id);
  const reader = await db.user.create({ data: { id: generateId(), githubId: 202402, githubUsername: 'tmpl-member' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'CONTRIBUTOR' } });
  managerOnly = asUser(reader.id);
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Coordinator role' }, ctx);
  agentId = agent.id;
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Tmpl team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
});
afterEach(() => vi.restoreAllMocks());

const declare = (name: string, extra: Record<string, unknown> = {}) =>
  M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name, cadenceSeconds: 600, ...extra } }, ctx);
const cast = (name: string) => M.castWorker({}, { appRef: appId, agentRef: agentId, name }, ctx);
const liveTickers = () => db.ticker.findMany({ where: { appId, deletedAt: null }, orderBy: { name: 'asc' } });
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e) => e?.extensions?.code ?? (e?.name === 'AgentNotFoundError' ? 'AGENT_NOT_FOUND' : String(e)));

describe('#2024 template CRUD', () => {
  it('creates, lists and returns the whole shape; omitted reasons default to read-team-channel', async () => {
    const t = await declare('Base tick');
    expect(t).toMatchObject({ revision: 1, shapeVersion: 1, name: 'Base tick', cadenceSeconds: 600, relevance: 'ALL', reasons: ['read-team-channel'] });
    const listed = await Q.agentTickerTemplates({}, { agentRef: agentId }, ctx);
    expect(listed.map((x: any) => x.id)).toEqual([t.id]);
  });

  it('refuses invalid input atomically: empty reasons, bad cadence, duplicate name ignoring case', async () => {
    expect(await refusal(declare('A', { reasons: [] }))).toBe('BAD_USER_INPUT');
    expect(await refusal(declare('A', { reasons: ['NOPE'] }))).toBe('BAD_USER_INPUT');
    expect(await refusal(declare('A', { cadenceSeconds: 0 }))).toBe('TICKER_CADENCE_OUT_OF_RANGE');
    expect(await refusal(declare('A', { cadenceSeconds: 86401 }))).toBe('TICKER_CADENCE_OUT_OF_RANGE');
    await declare('Heartbeat');
    expect(await refusal(declare('HEARTBEAT'))).toBe('TICKER_TEMPLATE_NAME_TAKEN');
    expect(await db.agentTickerTemplate.count({ where: { agentId } })).toBe(1);
  });

  it('update: omitted fields preserved, revision increments, a stale revision refuses and writes nothing', async () => {
    const t = await declare('Beat', { reasons: ['EVERY_TICK'], relevance: 'MENTIONS' });
    const u = await M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 3600 } }, ctx);
    expect(u).toMatchObject({ revision: 2, cadenceSeconds: 3600, name: 'Beat', relevance: 'MENTIONS', reasons: ['every-tick'] });
    expect(await refusal(M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 120 } }, ctx))).toBe('TICKER_TEMPLATE_REVISION_MISMATCH');
    expect((await db.agentTickerTemplate.findUniqueOrThrow({ where: { id: t.id } })).cadenceSeconds).toBe(3600);
    expect(await refusal(M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 2, input: { reasons: [] } }, ctx))).toBe('BAD_USER_INPUT');
    expect(await refusal(M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 2, input: {} }, ctx))).toBe('BAD_USER_INPUT');
    expect(await refusal(M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 2, input: { name: null } }, ctx))).toBe('BAD_USER_INPUT');
  });

  it('delete is soft, needs the revision, and frees the name', async () => {
    const t = await declare('Gone');
    expect(await refusal(M.deleteAgentTickerTemplate({}, { id: t.id, expectedRevision: 9 }, ctx))).toBe('TICKER_TEMPLATE_REVISION_MISMATCH');
    expect(await M.deleteAgentTickerTemplate({}, { id: t.id, expectedRevision: 1 }, ctx)).toBe(true);
    expect(await Q.agentTickerTemplates({}, { agentRef: agentId }, ctx)).toEqual([]);
    expect((await db.agentTickerTemplate.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).not.toBeNull();
    await expect(declare('Gone')).resolves.toMatchObject({ name: 'Gone' });
  });

  it('caps the live templates of one Agent', async () => {
    for (let i = 0; i < 20; i++) await declare(`T${i}`);
    expect(await refusal(declare('one too many'))).toBe('TICKER_TEMPLATE_LIMIT_REACHED');
  });
});

describe('#2024 authority', () => {
  it('writes need the Agent ADMIN door: a plain member and an outsider are refused, nothing written', async () => {
    const t = await declare('Mine');
    for (const who of [managerOnly, outsider]) {
      const code = await refusal(M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name: 'X', cadenceSeconds: 600 } }, who));
      expect(['FORBIDDEN', 'AGENT_NOT_FOUND']).toContain(code);
      expect(['FORBIDDEN', 'TICKER_TEMPLATE_NOT_FOUND']).toContain(await refusal(M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 120 } }, who)));
      expect(['FORBIDDEN', 'TICKER_TEMPLATE_NOT_FOUND']).toContain(await refusal(M.deleteAgentTickerTemplate({}, { id: t.id, expectedRevision: 1 }, who)));
    }
    expect(await db.agentTickerTemplate.findMany({ where: { agentId } })).toHaveLength(1);
    expect((await db.agentTickerTemplate.findUniqueOrThrow({ where: { id: t.id } })).revision).toBe(1);
  });

  it('an Agent the caller cannot read answers as absent for list, update and delete', async () => {
    const t = await declare('Hidden');
    expect(await refusal(Q.agentTickerTemplates({}, { agentRef: agentId }, outsider))).toBe('AGENT_NOT_FOUND');
    expect(await refusal(M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 120 } }, outsider))).toBe('TICKER_TEMPLATE_NOT_FOUND');
    expect(await refusal(M.deleteAgentTickerTemplate({}, { id: t.id, expectedRevision: 1 }, outsider))).toBe('TICKER_TEMPLATE_NOT_FOUND');
  });

  it('the Agent field shows none through a parent the caller cannot read, and reports the edit capability', async () => {
    await declare('Visible to editors');
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const F = (resolvers as any).Agent;
    expect(await F.tickerTemplates(agent, {}, ctx)).toHaveLength(1);
    expect(await F.tickerTemplates(agent, {}, outsider)).toEqual([]);
    expect(await F.viewerMayEditTickerTemplates(agent, {}, ctx)).toBe(true);
    expect(await F.viewerMayEditTickerTemplates(agent, {}, managerOnly)).toBe(false);
  });
});

describe('#2024 cast instantiation', () => {
  it('a cast creates every declared ticker, owned by and subscribed to the worker, with provenance', async () => {
    const base = await declare('Base tick', { reasons: ['READ_TEAM_CHANNEL'] });
    const beat = await declare('Heartbeat', { cadenceSeconds: 3600, reasons: ['EVERY_TICK'] });
    const worker = await cast('Iris');
    const tickers = await liveTickers();
    expect(tickers.map((t) => t.name)).toEqual(['Base tick · Iris', 'Heartbeat · Iris']);
    for (const t of tickers) {
      expect(t).toMatchObject({ ownerWorkerId: worker.id, generatedForWorkerId: worker.id, enabled: true });
      const subs = await db.tickerSubscription.findMany({ where: { tickerId: t.id } });
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ workerId: worker.id, endedAt: null });
    }
    expect(tickers.find((t) => t.name.startsWith('Heartbeat'))).toMatchObject({ sourceTemplateId: beat.id, sourceTemplateRevision: 1, reasons: ['every-tick'], cadenceSeconds: 3600 });
    expect(tickers.find((t) => t.name.startsWith('Base'))).toMatchObject({ sourceTemplateId: base.id, reasons: ['read-team-channel'] });
  });

  it('two casts of the same role into one App succeed with distinct ticker names and slugs', async () => {
    await declare('Base tick');
    await cast('Iris');
    await cast('Henry');
    const tickers = await liveTickers();
    expect(tickers.map((t) => t.name)).toEqual(['Base tick · Henry', 'Base tick · Iris']);
    expect(new Set(tickers.map((t) => t.slug)).size).toBe(2);
  });

  it('an Agent with no templates casts exactly as before, with no ticker', async () => {
    const worker = await cast('Plain');
    expect(worker).toMatchObject({ name: 'Plain' });
    expect(await liveTickers()).toEqual([]);
  });

  it('a below-floor template is clamped up to the App floor, not refused', async () => {
    await declare('Fast', { cadenceSeconds: 60 });
    await cast('Iris');
    const [t] = await liveTickers();
    expect(t!.cadenceSeconds).toBe(120); // the App's default floor
  });

  it('aggregate cap overflow refuses the WHOLE cast: no worker, name, ticker or subscription', async () => {
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 2 } });
    await declare('A'); await declare('B'); await declare('C');
    expect(await refusal(cast('Iris'))).toBe('TICKER_LIMIT_REACHED');
    expect(await db.worker.count({ where: { appId } })).toBe(0);
    expect(await db.ticker.count({ where: { appId } })).toBe(0);
    expect(await db.tickerSubscription.count()).toBe(0);
    // the name was not consumed by the failed cast
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 10 } });
    await expect(cast('Iris')).resolves.toMatchObject({ name: 'Iris' });
  });

  it('a generated name that is already a live ticker refuses the whole cast', async () => {
    await declare('Base tick');
    await db.ticker.create({ data: { appId, name: 'base tick · iris', slug: 'taken', cadenceSeconds: 600, ownerUserId: ctx.userId } });
    expect(await refusal(cast('Iris'))).toBe('TICKER_NAME_TAKEN');
    expect(await db.worker.count({ where: { appId } })).toBe(0);
  });

  it('a later template edit or removal reaches only future casts', async () => {
    const t = await declare('Base tick');
    const iris = await cast('Iris');
    await M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 7200 } }, ctx);
    await M.deleteAgentTickerTemplate({}, { id: t.id, expectedRevision: 2 }, ctx);
    const [existing] = await liveTickers();
    expect(existing).toMatchObject({ cadenceSeconds: 600, ownerWorkerId: iris.id, sourceTemplateRevision: 1 });
    await cast('Henry');
    expect(await liveTickers()).toHaveLength(1);
  });

  it('a retried generation cannot mint a second instance (database unique on worker + template)', async () => {
    const t = await declare('Base tick');
    const iris = await cast('Iris');
    await expect(db.ticker.create({
      data: { appId, name: 'dup', slug: 'dup', cadenceSeconds: 600, ownerWorkerId: iris.id, sourceTemplateId: t.id, sourceTemplateRevision: 1, generatedForWorkerId: iris.id },
    })).rejects.toThrow();
  });

  it('provenance is all-or-nothing and owned by the worker it was made for (CHECK)', async () => {
    await expect(db.ticker.create({
      data: { appId, name: 'half', slug: 'half', cadenceSeconds: 600, ownerUserId: ctx.userId, sourceTemplateId: 'x' },
    })).rejects.toThrow();
  });

  it('a generated ticker cannot be owned by a user, or by a different worker, than the one it was made for (CHECK)', async () => {
    await declare('Base');
    const iris = await cast('Iris');
    const henry = await cast('Henry');
    const generated = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: iris.id } });
    // Complete provenance, a valid user owner, no worker owner: `owner_worker_id = generated_for_worker_id` is NULL there.
    await expect(db.ticker.update({ where: { id: generated.id }, data: { ownerUserId: ctx.userId, ownerWorkerId: null } })).rejects.toThrow();
    await expect(db.ticker.update({ where: { id: generated.id }, data: { ownerWorkerId: henry.id } })).rejects.toThrow();
    expect((await db.ticker.findUniqueOrThrow({ where: { id: generated.id } })).ownerWorkerId).toBe(iris.id);
  });

  it('the preview shows requested and effective cadence, reserves nothing, and refuses where the cast would', async () => {
    await declare('Fast', { cadenceSeconds: 60 });
    const preview = await Q.castWorkerPreview({}, { appRef: appId, agentRef: agentId, name: 'Iris' }, ctx);
    expect(preview.tickers).toEqual([expect.objectContaining({ name: 'Fast · Iris', requestedCadenceSeconds: 60, effectiveCadenceSeconds: 120, reasons: ['READ_TEAM_CHANNEL'] })]);
    expect(await db.ticker.count()).toBe(0);
    expect(await db.worker.count()).toBe(0);
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 1 } });
    await declare('Second');
    expect(await refusal(Q.castWorkerPreview({}, { appRef: appId, agentRef: agentId, name: 'Iris' }, ctx))).toBe('TICKER_LIMIT_REACHED');
  });
});

describe('#2024 retirement and repair', () => {
  it('retiring ends only the tickers generated for that worker, and the subscriptions to them', async () => {
    await declare('Base tick');
    const iris = await cast('Iris');
    const henry = await cast('Henry');
    const runtime = await db.ticker.create({ data: { appId, name: 'Iris runtime', slug: 'iris-runtime', cadenceSeconds: 600, ownerWorkerId: iris.id } });
    const appTicker = await db.ticker.create({ data: { appId, name: 'App wide', slug: 'app-wide', cadenceSeconds: 600, ownerUserId: ctx.userId } });
    const henrysGenerated = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: henry.id } });
    // Henry subscribes to Iris's generated ticker, to show those subscriptions end too.
    const irisGenerated = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: iris.id } });
    await db.tickerSubscription.create({ data: { tickerId: irisGenerated.id, workerId: henry.id } });

    await M.retireWorker({}, { workerRef: iris.id }, ctx);

    const gone = await db.ticker.findUniqueOrThrow({ where: { id: irisGenerated.id } });
    expect(gone.deletedAt).not.toBeNull();
    for (const keep of [runtime.id, appTicker.id, henrysGenerated.id]) {
      expect((await db.ticker.findUniqueOrThrow({ where: { id: keep } })).deletedAt).toBeNull();
    }
    const subs = await db.tickerSubscription.findMany({ where: { tickerId: irisGenerated.id } });
    expect(subs.every((s) => s.endedAt !== null)).toBe(true);
    expect(subs.find((s) => s.workerId === henry.id)?.endedReason).toBe('TICKER_DELETED');
    expect(subs.find((s) => s.workerId === iris.id)?.endedReason).toBe('WORKER_RETIRED');
    // Henry's own subscription to his own generated ticker is untouched.
    expect(await db.tickerSubscription.count({ where: { tickerId: henrysGenerated.id, workerId: henry.id, endedAt: null } })).toBe(1);
    // Retiring twice is idempotent.
    await M.retireWorker({}, { workerRef: iris.id }, ctx);
  });

  it('a verified-empty miscast cast from a templated Agent is still removable, taking its generated tickers with it', async () => {
    await declare('Base tick');
    const worker = await cast('Miscast');
    expect(await db.ticker.count({ where: { appId } })).toBe(1);
    expect(await M.deleteWorker({}, { workerRef: worker.id, confirmNoExternalAttribution: true }, ctx)).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.ticker.count({ where: { appId } })).toBe(0);
  });

  it('a generated ticker another worker subscribed to is a real reference: the repair refuses', async () => {
    await declare('Base tick');
    const miscast = await cast('Miscast');
    const other = await cast('Other');
    const generated = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: miscast.id } });
    await db.tickerSubscription.create({ data: { tickerId: generated.id, workerId: other.id } });
    expect(await refusal(M.deleteWorker({}, { workerRef: miscast.id, confirmNoExternalAttribution: true }, ctx))).toBe('WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: miscast.id } })).not.toBeNull();
  });
});

describe('#2024 repair carve-out stays narrow', () => {
  it('a real non-ticker reference still refuses the repair, whatever generated tickers the worker has', async () => {
    await declare('Base tick');
    const miscast = await cast('Miscast');
    await db.session.create({ data: { workerId: miscast.id, startedAt: new Date(), endedAt: new Date(), summary: 'did work' } as any });
    expect(await refusal(M.deleteWorker({}, { workerRef: miscast.id, confirmNoExternalAttribution: true }, ctx))).toBe('WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: miscast.id } })).not.toBeNull();
  });

  it('a generated ticker that was deleted is history, not bookkeeping: the repair refuses', async () => {
    await declare('Base tick');
    const miscast = await cast('Miscast');
    const generated = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: miscast.id } });
    await db.ticker.update({ where: { id: generated.id }, data: { deletedAt: new Date() } });
    expect(await refusal(M.deleteWorker({}, { workerRef: miscast.id, confirmNoExternalAttribution: true }, ctx))).toBe('WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: miscast.id } })).not.toBeNull();
  });
});

describe('#2024 MCP parity', () => {
  const server = () => createTestableMcpServer({ userId: ctx.userId, roles: ['READER'] });
  it('create, list, update (stale refused) and delete go through the same resolvers', async () => {
    const created = await server().callToolText('hadron_agent_ticker_template_create', {
      agentRef: agentId, name: 'Heartbeat', cadenceSeconds: 3600, reasons: ['every-tick'],
    });
    expect(created).toMatch(/^Created\./);
    const row = await db.agentTickerTemplate.findFirstOrThrow({ where: { agentId } });
    expect(row).toMatchObject({ reasons: ['every-tick'], cadenceSeconds: 3600, revision: 1 });
    const listed = await server().callToolText('hadron_agent_ticker_template_list', { agentRef: agentId });
    expect(listed).toContain(row.id);
    expect(listed).toContain('revision 1');
    expect(listed).toContain('reasons every-tick');
    expect(await server().callToolText('hadron_agent_ticker_template_update', { id: row.id, expectedRevision: 1, cadenceSeconds: 1800 })).toMatch(/^Updated\./);
    const stale = await server().callToolText('hadron_agent_ticker_template_update', { id: row.id, expectedRevision: 1, cadenceSeconds: 900 });
    expect(stale).toMatch(/ticker_template_revision_mismatch/);
    expect((await db.agentTickerTemplate.findUniqueOrThrow({ where: { id: row.id } })).cadenceSeconds).toBe(1800);
    expect(await server().callToolText('hadron_agent_ticker_template_delete', { id: row.id, expectedRevision: 2 })).toBe('Deleted.');
  });

  it('an unauthorized MCP caller is refused the same way', async () => {
    const text = await createTestableMcpServer({ userId: managerOnly.userId, roles: ['READER'] }).callToolText('hadron_agent_ticker_template_create', {
      agentRef: agentId, name: 'Nope', cadenceSeconds: 600,
    });
    expect(text).toMatch(/\[(forbidden|agent_not_found)\]/);
    expect(await db.agentTickerTemplate.count()).toBe(0);
  });
});

describe('#2024 concurrency', () => {
  const settle = (...ps: Array<Promise<unknown>>) => Promise.allSettled(ps);
  const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason as any)?.extensions?.code : null);

  it('two concurrent casts of one name: one wins, the other is name-taken, and exactly one set of tickers exists', async () => {
    await declare('A'); await declare('B');
    const results = await settle(cast('Iris'), cast('Iris'));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter(Boolean)).toEqual(['WORKER_NAME_TAKEN']);
    const winner = await db.worker.findFirstOrThrow({ where: { appId } });
    const tickers = await liveTickers();
    expect(tickers).toHaveLength(2);
    expect(tickers.every((t) => t.ownerWorkerId === winner.id && t.generatedForWorkerId === winner.id)).toBe(true);
    expect(await db.tickerSubscription.count({ where: { workerId: winner.id, endedAt: null } })).toBe(2);
  });

  it('concurrent casts racing the live cap: the aggregate check admits one whole cast, never half of two', async () => {
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 3 } });
    await declare('A'); await declare('B');
    const results = await settle(cast('Iris'), cast('Henry'), cast('Quinn'));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter(Boolean)).toEqual(['TICKER_LIMIT_REACHED', 'TICKER_LIMIT_REACHED']);
    expect(await db.worker.count({ where: { appId } })).toBe(1);
    expect(await liveTickers()).toHaveLength(2);
  });

  it('a template edit racing a cast: the ticker records the revision whose content it carries', async () => {
    const t = await declare('Beat', { cadenceSeconds: 600 });
    const [, edit] = await Promise.all([
      cast('Iris'),
      M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 7200 } }, ctx),
    ]);
    expect(edit.revision).toBe(2);
    const [ticker] = await liveTickers();
    expect(ticker!.sourceTemplateRevision === 1 ? ticker!.cadenceSeconds : -1).toBe(ticker!.sourceTemplateRevision === 1 ? 600 : -1);
    if (ticker!.sourceTemplateRevision === 2) expect(ticker!.cadenceSeconds).toBe(7200);
    expect([1, 2]).toContain(ticker!.sourceTemplateRevision);
  });

  it('two concurrent edits at one revision: one applies, the other is a revision mismatch', async () => {
    const t = await declare('Beat');
    const results = await settle(
      M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 900 } }, ctx),
      M.updateAgentTickerTemplate({}, { id: t.id, expectedRevision: 1, input: { cadenceSeconds: 1800 } }, ctx),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter(Boolean)).toEqual(['TICKER_TEMPLATE_REVISION_MISMATCH']);
    expect((await db.agentTickerTemplate.findUniqueOrThrow({ where: { id: t.id } })).revision).toBe(2);
  });

  it('a cast racing a retirement of another worker leaves both consistent', async () => {
    await declare('Base');
    const iris = await cast('Iris');
    const [henry] = await Promise.all([cast('Henry'), M.retireWorker({}, { workerRef: iris.id }, ctx)]);
    const live = await liveTickers();
    expect(live.map((t) => t.generatedForWorkerId)).toEqual([henry.id]);
    expect(await db.tickerSubscription.count({ where: { workerId: henry.id, endedAt: null } })).toBe(1);
  });
});

describe('#2024 lock protocol (two-connection barriers)', () => {
  /** Hold `take` open in its own transaction until the returned release is called. */
  const open: Array<{ release: () => void; holder: Promise<void> }> = [];
  afterEach(async () => { for (const h of open.splice(0)) { h.release(); await h.holder.catch(() => undefined); } });
  /** Resolve once a backend is blocked on THIS advisory key (not just any advisory lock). */
  async function waitForWaiterOnKey(key: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_locks l, (SELECT hashtextextended(${key}, 0) AS h) k
        WHERE l.locktype = 'advisory' AND NOT l.granted
          AND l.classid::bigint = ((k.h >> 32) & 4294967295) AND l.objid::bigint = (k.h & 4294967295)`;
      if (waiting >= 1) return;
      if (Date.now() > deadline) throw new Error(`no backend blocked on advisory key ${key}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async function hold(take: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>, after?: () => Promise<void>) {
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => { await take(tx); locked(); await done; }, { timeout: 30_000 });
    await ready;
    await after?.();
    const handle = { release: () => release(), holder };
    open.push(handle);
    return handle;
  }

  it('a cast waits for an in-flight template write and then SEES it (the empty-set fence)', async () => {
    const h = await hold(async (tx) => {
      await lockAgentTemplates(tx, agentId, 'exclusive');
      await tx.agentTickerTemplate.create({ data: { agentId, name: 'Uncommitted', cadenceSeconds: 600, reasons: ['read-team-channel'] } });
    });
    const casting = cast('Iris');
    await waitForWaiterOnKey(`agent-ticker-templates:${agentId}`);
    h.release(); await h.holder;
    await casting;
    expect((await liveTickers()).map((t) => t.name)).toEqual(['Uncommitted \u00b7 Iris']);
  });

  it('an Agent uninstalled while a cast waits for the template lock refuses the cast and writes nothing', async () => {
    await declare('Base');
    const h = await hold(async (tx) => { await lockAgentTemplates(tx, agentId, 'exclusive'); });
    const casting = refusal(cast('Iris'));
    await waitForWaiterOnKey(`agent-ticker-templates:${agentId}`);
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
    h.release(); await h.holder;
    expect(await casting).toBe('WORKER_AGENT_NOT_INSTALLED');
    expect(await db.worker.count({ where: { appId } })).toBe(0);
    expect(await db.ticker.count({ where: { appId } })).toBe(0);
    expect(await db.tickerSubscription.count()).toBe(0);
  });

  it('a cast waits for the App ticker lock, as every ticker write does', async () => {
    await declare('Base');
    const h = await hold(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tickers:${appId}`}, 0))`; });
    const casting = cast('Iris').then(() => 'cast');
    await waitForWaiterOnKey(`tickers:${appId}`);
    expect(await db.worker.count({ where: { appId } })).toBe(0);
    h.release(); await h.holder;
    expect(await casting).toBe('cast');
  });

  it('a retirement takes the App ticker lock before it touches the worker row', async () => {
    await declare('Base');
    const iris = await cast('Iris');
    const h = await hold(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tickers:${appId}`}, 0))`; });
    const retiring = M.retireWorker({}, { workerRef: iris.id }, ctx).then(() => 'retired');
    await waitForWaiterOnKey(`tickers:${appId}`);
    expect((await db.worker.findUniqueOrThrow({ where: { id: iris.id } })).retiredAt).toBeNull();
    h.release(); await h.holder;
    expect(await retiring).toBe('retired');
    expect(await liveTickers()).toEqual([]);
  });

  it('an editor demoted while their write waits is refused: the authority is decided inside the transaction', async () => {
    const adminId = ctx.userId!;
    const h = await hold(async (tx) => {
      // What a revoker does: the org anchor exclusive first, then the change.
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }], 'exclusive');
      await tx.orgMember.updateMany({ where: { organizationId: orgId, userId: adminId }, data: { role: 'CONTRIBUTOR' } });
    });
    const writing = refusal(M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name: 'Late', cadenceSeconds: 600 } }, ctx));
    await waitForLockWaitersOfType(db as any, 'advisory');
    h.release(); await h.holder;
    expect(await writing).toBe('FORBIDDEN');
    expect(await db.agentTickerTemplate.count({ where: { agentId } })).toBe(0);
  });
});
