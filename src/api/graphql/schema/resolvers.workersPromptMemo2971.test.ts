/**
 * #2971 Slice 1 — `workers(appRef)` selecting `prompt` composes every worker's briefing; the shared reads of one page
 * (the Agent row, the install/Agent-level served prompt, the viewer's and a holder's accessible-memory sets) are read
 * once per PAGE, never per worker, while every per-worker input stays per worker (the worker read gate, the open-session
 * placement, the USER-owned template gate, the worker's own pointer, the recorded revision, the platform variables and
 * the register for the worker's own holder). The memo lives on the page's rows, never on ctx (cor:agt:020:01: a briefing
 * is never cached).
 *
 * Parity: each item of the page is byte-identical to the same worker composed WITHOUT the memo (a single read).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt } from './resolvers.worker.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any, Q = resolvers.Query as any, W = resolvers.Worker as any;
let org: any, app: any, agent: any, admin: any, outsider: any, memory: any;
const ctxOf = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const adminCtx = (extra: Partial<Context> = {}) => ctxOf(admin.id, extra);

const cast = async (name: string) => {
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name }, adminCtx());
  return db.worker.findUniqueOrThrow({ where: { id: made.id } });
};
const page = (ctx: Context, extra: Record<string, unknown> = {}) => Q.workers({}, { appRef: app.id, limit: 200, ...extra }, ctx);
/** The same worker, composed from a plain row (no page, so no memo): the single-read answer. */
const single = async (ctx: Context, id: string) => {
  const row = await db.worker.findUniqueOrThrow({ where: { id } });
  const out = await composeWorkerPrompt(ctx, row);
  return { text: out.text, refusal: out.refusal ?? null, prompt: await W.prompt(row, {}, ctx) };
};
const viaPage = async (ctx: Context, item: any) => {
  const out = await composeWorkerPrompt(ctx, item);
  return { text: out.text, refusal: out.refusal ?? null, prompt: await W.prompt(item, {}, ctx) };
};
const expectParity = async (ctx: Context) => {
  const { items } = await page(ctx);
  const got: Record<string, Awaited<ReturnType<typeof single>>> = {};
  for (const item of items) {
    const a = await viaPage(ctx, item);
    const b = await single(ctx, item.id);
    expect(a, `worker ${item.name}`).toEqual(b);
    got[item.name] = a;
  }
  return got;
};

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Memo', urn: `memo-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 95_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: `memo-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 96_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: `out-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Eng', personaRole: 'engineer' }, adminCtx());
  await serveAgentBootPrompt(db, agent.id, 'SHARED {{worker.name}} {{worker.role}} {{agent.name}}');
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const c = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:all', name: 'all', createdBy: admin.id });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: c.channel.id, role: 'BOTH' } });
});

describe('#2971 parity: every item of the page equals its single read', () => {
  it('plain page: each worker is served its own name and role, and the page equals the single reads', async () => {
    await cast('Ada');
    await cast('Bea');
    const got = await expectParity(adminCtx());
    expect(got.Ada?.text).toContain('SHARED Ada engineer Eng');
    expect(got.Bea?.text).toContain('SHARED Bea engineer Eng');
  });

  it('(a) a worker with an open RECORDED session finishes under its recorded revision; the rest read the live one', async () => {
    const ada = await cast('Ada');
    await cast('Bea');
    const open = await M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: ada.id, force: true } }, adminCtx());
    await serveAgentBootPrompt(db, agent.id, 'RECOMPILED {{worker.name}}');
    const ctx = adminCtx({ sessionId: open.id });
    const got = await expectParity(ctx);
    expect(got.Ada?.text).toContain('SHARED Ada');
    expect(got.Bea?.text).toContain('RECOMPILED Bea');
    // Another reader with no session sees the recompile for Ada too: the record is the caller's own session's.
    const other = await expectParity(adminCtx());
    expect(other.Ada?.text).toContain('RECOMPILED Ada');
  });

  it('(b) a worker whose Agent is USER-owned reads null for a non-owner member, the text for its holder', async () => {
    await cast('Ada');
    const owner = await db.user.create({ data: { githubId: 97_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: `own-${generateId().toLowerCase()}`, roles: ['READER'] } });
    const mine = await M.createAgent({}, { name: 'Private', personaRole: 'private' }, ctxOf(owner.id));
    await serveAgentBootPrompt(db, mine.id, 'PRIVATE {{worker.name}}');
    await db.appAgent.create({ data: { appId: app.id, agentId: mine.id } });
    const w = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: mine.id, name: 'Priv', slug: 'priv', signature: 's', trailer: 't', role: 'private' } });
    const first = await expectParity(adminCtx());
    expect(first.Priv?.text).toBeNull();
    expect(first.Ada?.text).toContain('SHARED Ada');
    // The person holding the worker cast from it reads it (the same predicate, per worker).
    await db.worker.update({ where: { id: w.id }, data: { heldByUserId: admin.id } });
    const held = await expectParity(adminCtx());
    expect(held.Priv?.text).toContain('PRIVATE Priv');
  });

  it('(c) a caller who fails the worker read gate reads null on a page another caller built, and on every single read', async () => {
    await cast('Ada');
    await cast('Bea');
    const { items } = await page(adminCtx());
    // The page was composed for the admin first, so a shared entry exists; the outsider must still read null.
    for (const item of items) expect((await viaPage(adminCtx(), item)).text).toContain('SHARED');
    for (const item of items) {
      expect(await viaPage(ctxOf(outsider.id), item)).toEqual({ text: null, refusal: null, prompt: null });
      expect((await single(ctxOf(outsider.id), item.id)).text).toBeNull();
    }
    await expect(page(ctxOf(outsider.id))).rejects.toThrow();
  });

  it('(d) a customised worker (its own pointer) sits beside an uncustomised worker of the same Agent', async () => {
    const ada = await cast('Ada');
    await cast('Bea');
    const other = await M.createAgent({}, { orgId: org.id, name: 'Other', personaRole: 'other' }, adminCtx());
    const custom = await serveAgentBootPrompt(db, other.id, 'CUSTOM {{worker.name}}');
    await db.worker.update({ where: { id: ada.id }, data: { bootPromptNodeId: custom, bootPromptUrn: `test:${custom}` } });
    const got = await expectParity(adminCtx());
    expect(got.Ada?.text).toContain('CUSTOM Ada');
    expect(got.Bea?.text).toContain('SHARED Bea');
  });

  it('(e) an install pointer whose target is deleted refuses every uncustomised worker; the customised one still reads its own text', async () => {
    const ada = await cast('Ada');
    await cast('Bea');
    await cast('Cy');
    const other = await M.createAgent({}, { orgId: org.id, name: 'Other', personaRole: 'other' }, adminCtx());
    const custom = await serveAgentBootPrompt(db, other.id, 'CUSTOM {{worker.name}}');
    const installNode = await serveAgentBootPrompt(db, other.id, 'INSTALL {{worker.name}}');
    await db.appAgent.update({ where: { appId_agentId: { appId: app.id, agentId: agent.id } }, data: { bootPromptNodeId: installNode, bootPromptUrn: `test:${installNode}` } });
    await db.worker.update({ where: { id: ada.id }, data: { bootPromptNodeId: custom, bootPromptUrn: `test:${custom}` } });
    await db.node.delete({ where: { id: installNode } });
    const got = await expectParity(adminCtx());
    expect(got.Ada?.text).toContain('CUSTOM Ada');
    expect(got.Bea).toMatchObject({ text: null, refusal: 'BOOT_PROMPT_TARGET_DELETED' });
    expect(got.Cy).toMatchObject({ text: null, refusal: 'BOOT_PROMPT_TARGET_DELETED' });
  });
});

describe('#2971 the memo is one page long and holds only what the workers of a page share', () => {
  it('a mutation that changes the persona, then a second page read in the same request context, serves the new text', async () => {
    await cast('Ada');
    const ctx = adminCtx();
    const first = await page(ctx);
    expect(await W.prompt(first.items[0], {}, ctx)).toContain('SHARED Ada');
    await serveAgentBootPrompt(db, agent.id, 'EDITED {{worker.name}}');
    // Same ctx object, a new page resolution: nothing survives from the first.
    const second = await page(ctx);
    expect(await W.prompt(second.items[0], {}, ctx)).toContain('EDITED Ada');
  });

  it('the shared reads do not grow per worker: a 50-worker page reads the Agent, the install level and the served revision once', async () => {
    for (let i = 0; i < 50; i++) await cast(`W${i}`);
    await db.worker.updateMany({ where: { appId: app.id }, data: { heldByUserId: admin.id } });
    const ctx = adminCtx();
    const { items } = await page(ctx);
    expect(items).toHaveLength(50);
    const spies = {
      agent: vi.spyOn(db.agent, 'findUnique'),
      appAgent: vi.spyOn(db.appAgent, 'findFirst'),
      compiled: vi.spyOn(db.compiledPromptRevision, 'findFirst'),
      approved: vi.spyOn(db.nodeRevision, 'findMany'),
      memories: vi.spyOn(db.memory, 'findMany'),
      members: vi.spyOn(db.orgMember, 'findMany'),
    };
    for (const item of items) expect(await W.prompt(item, {}, ctx)).toContain('SHARED');
    const calls = Object.fromEntries(Object.entries(spies).map(([k, s]) => [k, s.mock.calls.length]));
    // Shared reads: a constant number per page (a worker-level pointer read and the shared level read together stay far below N).
    expect(calls.agent, JSON.stringify(calls)).toBeLessThanOrEqual(2);
    expect(calls.appAgent, JSON.stringify(calls)).toBeLessThanOrEqual(1);
    expect(calls.compiled, JSON.stringify(calls)).toBeLessThanOrEqual(1);
    expect(calls.approved, JSON.stringify(calls)).toBeLessThanOrEqual(2);
    // The viewer's and the one holder's accessible-memory sets: computed once each for the page.
    expect(calls.memories, JSON.stringify(calls)).toBeLessThanOrEqual(10);
    expect(calls.members, JSON.stringify(calls)).toBeLessThanOrEqual(10);
  });
});
