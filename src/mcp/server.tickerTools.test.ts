/**
 * #1747 — the ticker tools on the MCP surface.
 *
 * The rules are pinned in resolvers.ticker.test.ts; this covers the SURFACE:
 * every write requires `session` and refuses without it (never inferred —
 * #1697/#1701), a worker session makes the worker the actor, an unusable
 * session is refused, refusals arrive as `[code] message` envelopes with the
 * GraphQL codes, wake settings read without a session and set with one.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { TICKER_WRITE_TOOLS } from './tickerTools.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../api/graphql/schema/resolvers.teamChat.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let holder: { id: string };
let app: { id: string; urn: string };
let agentId: string;
let anne: { id: string };
let liam: { id: string };
let post: ReturnType<typeof vi.spyOn>;

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcp = (auth: AuthContext) =>
  createTestableMcpServer(auth, { sessionId: `tk-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';

async function session(data: { userId?: string; appId?: string; workerId?: string }) {
  return db.session.create({
    data: { id: generateId(), ...data, ...(data.workerId ? { agentId } : {}) },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Tick MCP', urn: `tickmcp-${generateId().toLowerCase()}.example` } });
  admin = await db.user.create({ data: { githubId: 181001, githubUsername: 'tk-admin', handle: 'tk-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 181002, githubUsername: 'tk-member', handle: 'tk-member', roles: [] } });
  holder = await db.user.create({ data: { githubId: 181003, githubUsername: 'tk-holder', handle: 'tk-holder', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  agentId = agent.id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id.toLowerCase()}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  anne = await db.worker.create({ data: { appId: app.id, agentId, name: 'Anne', slug: 'anne', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  liam = await db.worker.create({ data: { appId: app.id, agentId, name: 'Liam', slug: 'liam', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
});

afterEach(() => post.mockRestore());

describe('ticker tools: who acts', () => {
  it('every write tool refuses without a session, and writes nothing', async () => {
    const s = mcp(authOf(member.id));
    for (const tool of TICKER_WRITE_TOOLS) {
      const r = text(await s.callTool(tool, {
        appRef: app.id, name: 'x', cadenceSeconds: 600, ref: generateId(), workerRef: anne.id,
      }));
      expect({ tool, code: code(r) }).toEqual({ tool, code: 'SESSION_REQUIRED' });
    }
    expect(await db.ticker.count()).toBe(0);
    // Setting wake settings is a write too.
    expect(code(text(await s.callTool('hadron_worker_wake_settings', { workerRef: anne.id, mentions: 'OFF' })))).toBe('SESSION_REQUIRED');
    expect(await db.workerWakeSettings.count()).toBe(0);
  });

  it('a session that is not one of yours is refused', async () => {
    const s = mcp(authOf(member.id));
    const foreign = await session({ userId: admin.id });
    for (const sid of [generateId(), foreign.id]) {
      expect(code(text(await s.callTool('hadron_ticker_create', { appRef: app.id, name: 'x', cadenceSeconds: 600, session: sid })))).toBe('SESSION_NOT_BOUND');
    }
    expect(await db.ticker.count()).toBe(0);
  });

  it('a plain session acts as the person; a worker session as the worker', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const sh = mcp(authOf(holder.id));
    const asAnne = await session({ userId: holder.id, appId: app.id, workerId: anne.id });
    expect(text(await s.callTool('hadron_ticker_create', { appRef: app.id, name: 'Mine', cadenceSeconds: 600, session: plain.id }))).toMatch(/^Created\./);
    expect(text(await sh.callTool('hadron_ticker_create', { appRef: app.id, name: 'Hers', cadenceSeconds: 600, session: asAnne.id }))).toMatch(/^Created\./);
    const [a, b] = await Promise.all([
      db.ticker.findFirstOrThrow({ where: { slug: 'mine' } }),
      db.ticker.findFirstOrThrow({ where: { slug: 'hers' } }),
    ]);
    expect([a.ownerUserId, a.ownerWorkerId]).toEqual([member.id, null]);
    expect([b.ownerUserId, b.ownerWorkerId, b.createdByWorkerId]).toEqual([null, anne.id, anne.id]);
  });

  it('a full flow through the tools, with the GraphQL refusal codes', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const sh = mcp(authOf(holder.id));
    const holderPlain = await session({ userId: holder.id });
    const asLiam = await session({ userId: holder.id, appId: app.id, workerId: liam.id });

    const created = text(await s.callTool('hadron_ticker_create', {
      appRef: app.id, name: 'Engineering', cadenceSeconds: 120,
      quietHours: { timezone: 'UTC', windows: [{ days: [6, 7], from: '00:00', to: '23:59' }] }, session: plain.id,
    }));
    expect(created).toMatch(/hrn:ticker:.*:team:engineering · every 120s · enabled · relevance ALL/);
    expect(created).toMatch(/quiet hours UTC \(1 window\)/);
    expect(code(text(await s.callTool('hadron_ticker_create', { appRef: app.id, name: 'engineering', cadenceSeconds: 600, session: plain.id })))).toBe('TICKER_NAME_TAKEN');
    expect(code(text(await s.callTool('hadron_ticker_create', { appRef: app.id, name: 'Fast', cadenceSeconds: 30, session: plain.id })))).toBe('TICKER_CADENCE_OUT_OF_RANGE');

    // R3 over the wire: the worker itself cannot take the 120 s ticker; its holder can.
    expect(code(text(await sh.callTool('hadron_ticker_subscribe', { ref: 'x', workerRef: liam.id, session: asLiam.id })))).toBe('TICKER_NOT_FOUND');
    const t = await db.ticker.findFirstOrThrow({ where: { slug: 'engineering' } });
    expect(code(text(await sh.callTool('hadron_ticker_subscribe', { ref: t.id, workerRef: liam.id, session: asLiam.id })))).toBe('SUBSCRIBE_CADENCE_NEEDS_HOLDER');
    expect(text(await sh.callTool('hadron_ticker_subscribe', { ref: t.id, workerRef: liam.id, session: holderPlain.id }))).toMatch(/^Subscribed\./);

    const list = text(await s.callTool('hadron_ticker_list', { appRef: app.id }));
    expect(list).toMatch(/1 ticker:/);
    expect(list).toMatch(/subscribers: Liam/);

    // Wake settings: read with no session, set with one.
    expect(text(await s.callTool('hadron_worker_wake_settings', { workerRef: liam.id }))).toMatch(/Liam: mentions IMMEDIATE, not paused[\s\S]*Engineering · effective cadence 120s|subscriptions: Engineering · effective cadence 120s/);
    expect(code(text(await s.callTool('hadron_worker_wake_settings', { workerRef: liam.id, mentions: 'OFF', session: plain.id })))).toBe('WAKE_SETTINGS_FORBIDDEN');
    expect(text(await sh.callTool('hadron_worker_wake_settings', { workerRef: liam.id, mentions: 'OFF', session: holderPlain.id }))).toMatch(/^Updated\.\nLiam: mentions OFF/);

    expect(text(await sh.callTool('hadron_ticker_unsubscribe', { ref: t.id, workerRef: liam.id, session: holderPlain.id }))).toMatch(/^Unsubscribed\./);
    expect(text(await s.callTool('hadron_ticker_update', { ref: t.id, enabled: false, clearQuietHours: true, session: plain.id }))).toMatch(/disabled/);
    expect(code(text(await sh.callTool('hadron_ticker_delete', { ref: t.id, session: holderPlain.id })))).toBe('FORBIDDEN');
    expect(text(await s.callTool('hadron_ticker_delete', { ref: t.id, session: plain.id }))).toMatch(/^Deleted/);
    expect(text(await s.callTool('hadron_ticker_list', { appRef: app.id }))).toBe('No live tickers.');
  });

  it('a write acts as the NAMED session: a worker session cannot use its driver\'s holder rights on another worker', async () => {
    const sh = mcp(authOf(holder.id));
    const asLiam = await session({ userId: holder.id, appId: app.id, workerId: liam.id });
    const asHolder = await session({ userId: holder.id });
    // Anne and Liam are both held by `holder`. Liam's session is Liam, not the person behind it.
    expect(code(text(await sh.callTool('hadron_worker_wake_settings', { workerRef: anne.id, mentions: 'OFF', session: asLiam.id })))).toBe('WAKE_SETTINGS_FORBIDDEN');
    expect(await db.workerWakeSettings.count()).toBe(0);
    // Its own settings are its to change, and the person's plain session still reaches both.
    expect(text(await sh.callTool('hadron_worker_wake_settings', { workerRef: liam.id, mentions: 'OFF', session: asLiam.id }))).toMatch(/^Updated\./);
    expect(text(await sh.callTool('hadron_worker_wake_settings', { workerRef: anne.id, mentions: 'OFF', session: asHolder.id }))).toMatch(/^Updated\./);
    // hadron_ack_wakes is actor-neutral too: it runs as the named session and reaches the proof check.
    expect(code(text(await sh.callTool('hadron_ack_wakes', { proofs: ['x'], session: asLiam.id })))).toBe('WAKE_PROOF_INVALID');
    expect(code(text(await sh.callTool('hadron_ack_wakes', { proofs: ['x'] })))).toBe('SESSION_REQUIRED');
  });

  it('tells the caller when a grant use could not be announced', async () => {
    const t = await db.ticker.create({ data: { appId: app.id, name: 'Slow', slug: 'slow', cadenceSeconds: 600, ownerUserId: member.id } });
    await M.grantApp({}, { appRef: app.id, workerRef: anne.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, { db, userId: admin.id, roles: ['READER'] });
    const sh = mcp(authOf(holder.id));
    const asAnne = await session({ userId: holder.id, appId: app.id, workerId: anne.id });
    expect(text(await sh.callTool('hadron_ticker_subscribe', { ref: t.id, workerRef: liam.id, session: asAnne.id }))).toMatch(/announced to the team chat/);
    post.mockRejectedValue(new Error('chat down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failed = text(await sh.callTool('hadron_ticker_unsubscribe', { ref: t.id, workerRef: liam.id, session: asAnne.id }));
    warn.mockRestore();
    expect(failed).toMatch(/^Unsubscribed\./);
    expect(failed).toMatch(/FAILED to post/);
  });
  it('due wakes: readable without a session by a holder or manager, concealed from outsiders; acknowledging is a write', async () => {
    const outsider = await db.user.create({ data: { githubId: 181009, githubUsername: 'tk-out', handle: 'tk-out', roles: [] } });
    const sh = mcp(authOf(holder.id));
    expect(text(await sh.callTool('hadron_due_wakes', { appRef: app.id }))).toBe('Nothing is due.');
    expect(code(text(await mcp(authOf(outsider.id)).callTool('hadron_due_wakes', { appRef: app.id })))).toBe('APP_NOT_FOUND');
    expect(code(text(await sh.callTool('hadron_ack_wakes', { proofs: ['x'] })))).toBe('SESSION_REQUIRED');
    const plain = await session({ userId: holder.id });
    expect(code(text(await sh.callTool('hadron_ack_wakes', { proofs: ['x'], session: plain.id })))).toBe('WAKE_PROOF_INVALID');
  });
});
