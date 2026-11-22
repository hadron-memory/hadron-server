/**
 * #4829 (cor:dmo:080:04, Decided: no tool connection is left that no live row points to) — a tool registration whose
 * RESPONSE is lost must not leave an unowned registration, and the retry must not duplicate it. One mechanism covers
 * both providers: core sends a registrationKey derived from (App, credentials) and the tool returns its existing
 * connection only when the stored key matches.
 *
 * The REAL clients run against an in-process stateful fake tool (a stubbed fetch), so the pins assert the invariant
 * itself: after a dropped first response and a retry the tool holds exactly ONE live connection AND a live core row
 * points to it. The fake follows the contract filed as hadrontool-telegram#5 / hadrontool-slack#4. A `legacy` fake
 * ignores registrationKey and refuses a duplicate with a 400, like both tools do today.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { toolRegistrationKey } from '../../../lib/toolRegistrationKey.js';
import { resolvers, type Context } from './resolvers.js';

type Mode = 'keyed' | 'legacy';
interface ToolRow { id: string; identity: string; key: string | null; deleted: boolean }

/** A stateful fake of the tool's POST/DELETE /connections. `dropNext` makes the NEXT POST commit and then lose its response. */
function fakeTool(mode: Mode, identityOf: (body: Record<string, unknown>) => { identity: string; body: Record<string, unknown> }) {
  const rows: ToolRow[] = [];
  // `holdPosts(n)`: the first n POSTs are answered only once all n have arrived, so n callers are past their pre-checks
  // and all hold the tool's answer before any of them writes its core row (a deterministic race, no timing).
  let hold = 0;
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let dropNext = false;
  let seq = 0;
  const handler = async (url: string, init: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (init.method === 'DELETE') {
      const row = rows.find((r) => url.endsWith(`/connections/${r.id}`));
      if (row) row.deleted = true;
      return json(200, { deleted: true });
    }
    const input = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    if (hold > 0 && ++arrived >= hold) release();
    const { identity, body } = identityOf(input);
    const key = mode === 'keyed' && typeof input.registrationKey === 'string' ? input.registrationKey : null;
    const existing = rows.find((r) => !r.deleted && r.identity === identity);
    let out: Response;
    if (existing) {
      out = key !== null && existing.key === key
        ? json(200, { ...body, id: existing.id })
        : json(400, { error: 'validation_error', message: `a connection already exists (${existing.id})` });
    } else {
      const row: ToolRow = { id: `tool-${++seq}`, identity, key, deleted: false };
      rows.push(row);
      out = json(201, { ...body, id: row.id });
    }
    if (hold > 0 && arrived <= hold) await gate;
    if (dropNext && out.ok) {
      dropNext = false;
      throw new TypeError('fetch failed'); // the tool committed; the response never arrived
    }
    return out;
  };
  return { rows, live: () => rows.filter((r) => !r.deleted), dropNext: () => { dropNext = true; }, holdPosts: (n: number) => { hold = n; }, handler };
}

const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId }) as Context;
let org: { id: string };
let appA: { id: string };
let appB: { id: string };
let admin: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  process.env.TELEGRAM_TOOL_URL = 'http://telegram-tool.test';
  process.env.SLACK_TOOL_URL = 'http://slack-tool.test';
  org = await db.organization.create({ data: { id: generateId(), name: 'lr-org', urn: 'lr-org' } });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'a', urn: 'lr-org::a' } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'b', urn: 'lr-org::b' } });
  const user = await db.user.create({ data: { id: generateId(), email: 'lr@test.dev', name: 'lr' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  admin = user;
});
afterEach(() => {
  delete process.env.TELEGRAM_TOOL_URL;
  delete process.env.SLACK_TOOL_URL;
  vi.unstubAllGlobals();
});

const tgIdentity = (input: Record<string, unknown>) => ({
  identity: `bot:${String(input.botToken).split(':')[0]}`,
  body: { provider: 'telegram', botId: '99', botUsername: 'IrisBot', displayName: 'Iris', status: 'ACTIVE' },
});
const slIdentity = (input: Record<string, unknown>) => ({
  identity: `team:${String(input.botToken).slice(0, 8)}`,
  body: { provider: 'slack', teamId: 'T0001', teamName: 'Acme', botUserId: 'U0BOT', botId: 'B0BOT', status: 'ACTIVE' },
});

const createTg = (appRef: string) =>
  resolvers.Mutation.createTelegramConnection({}, { appRef, botToken: '123456:SECRET-tg' }, ctxFor(admin.id));
const createSl = (appRef: string) =>
  resolvers.Mutation.createSlackConnection(
    {},
    { orgRef: org.id, appRef, botToken: 'xoxb-secret-token', appToken: 'xapp-secret-token' },
    ctxFor(admin.id),
  );
const liveTg = () => db.telegramConnection.findMany({ where: { deletedAt: null } });
const liveSl = () => db.slackConnection.findMany({ where: { deletedAt: null } });

describe('#4829 lost registration response — Telegram', () => {
  it('a dropped first response then a retry leaves exactly one tool connection and a live core row pointing at it', async () => {
    const tool = fakeTool('keyed', tgIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    tool.dropNext();
    await expect(createTg(appA.id)).rejects.toMatchObject({ extensions: { code: 'TELEGRAM_TOOL_UNREACHABLE' } });
    expect(await liveTg()).toHaveLength(0); // core has no record; the tool holds an orphan right now
    const row = await createTg(appA.id);
    expect(tool.live()).toHaveLength(1);
    expect(row.toolConnectionId).toBe(tool.live()[0]!.id);
    expect(await liveTg()).toHaveLength(1);
  });

  it('never adopts a registration another App created: the same bot token from a different App is refused', async () => {
    const tool = fakeTool('keyed', tgIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    await createTg(appA.id);
    await expect(createTg(appB.id)).rejects.toMatchObject({ extensions: { code: 'TELEGRAM_TOOL_ERROR', status: 400 } });
    expect(tool.live()).toHaveLength(1);
    expect(await liveTg()).toHaveLength(1);
  });

  it('degrades exactly as before against a tool that ignores registrationKey: the retry is refused (400), nothing is adopted', async () => {
    const tool = fakeTool('legacy', tgIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    tool.dropNext();
    await expect(createTg(appA.id)).rejects.toMatchObject({ extensions: { code: 'TELEGRAM_TOOL_UNREACHABLE' } });
    await expect(createTg(appA.id)).rejects.toMatchObject({ extensions: { code: 'TELEGRAM_TOOL_ERROR', status: 400 } });
    expect(await liveTg()).toHaveLength(0);
    expect(tool.live()).toHaveLength(1); // the known orphan until the tool ships #5; core adds no new behavior here
  });
});

describe('#4829 lost registration response — Slack', () => {
  it('a dropped first response then a retry leaves exactly one tool connection and a live core row pointing at it', async () => {
    const tool = fakeTool('keyed', slIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    tool.dropNext();
    await expect(createSl(appA.id)).rejects.toMatchObject({ extensions: { code: 'SLACK_TOOL_UNREACHABLE' } });
    expect(await liveSl()).toHaveLength(0);
    const row = await createSl(appA.id);
    expect(tool.live()).toHaveLength(1);
    expect(row.toolConnectionId).toBe(tool.live()[0]!.id);
    expect(await liveSl()).toHaveLength(1);
  });

  it('never adopts a registration another App created', async () => {
    const tool = fakeTool('keyed', slIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    await createSl(appA.id);
    await expect(createSl(appB.id)).rejects.toMatchObject({ extensions: { status: 400 } });
    expect(tool.live()).toHaveLength(1);
  });

  it('degrades exactly as before against a tool that ignores registrationKey', async () => {
    const tool = fakeTool('legacy', slIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    tool.dropNext();
    await expect(createSl(appA.id)).rejects.toMatchObject({ extensions: { code: 'SLACK_TOOL_UNREACHABLE' } });
    await expect(createSl(appA.id)).rejects.toMatchObject({ extensions: { status: 400 } });
    expect(await liveSl()).toHaveLength(0);
  });
});

describe('#4829 a repeat or concurrent registration must not tear down the winner\'s tool row', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20)); // the teardown is fire-and-forget

  it('Slack: the same App registering the same install again is refused and the live connection keeps its tool row', async () => {
    const tool = fakeTool('keyed', slIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    const first = await createSl(appA.id);
    await expect(createSl(appA.id)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await settle();
    expect(tool.live().map((r) => r.id)).toEqual([first.toolConnectionId]);
    expect(await liveSl()).toHaveLength(1);
  });

  it('Slack: two concurrent registrations leave one core row pointing at a live tool row', async () => {
    const tool = fakeTool('keyed', slIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    tool.holdPosts(2);
    const results = await Promise.allSettled([createSl(appA.id), createSl(appA.id)]);
    await settle();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await liveSl();
    expect(rows).toHaveLength(1);
    expect(tool.live().map((r) => r.id)).toEqual([rows[0]!.toolConnectionId]);
  });

  it('Telegram: two concurrent registrations leave one core row pointing at a live tool row', async () => {
    const tool = fakeTool('keyed', tgIdentity);
    vi.stubGlobal('fetch', vi.fn(tool.handler));
    tool.holdPosts(2);
    const results = await Promise.allSettled([createTg(appA.id), createTg(appA.id)]);
    await settle();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await liveTg();
    expect(rows).toHaveLength(1);
    expect(tool.live().map((r) => r.id)).toEqual([rows[0]!.toolConnectionId]);
  });
});

describe('#4829 the key and the credentials never reach an error', () => {
  it('Slack: a tool that echoes its request in an error leaks neither the tokens nor the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body?: string }) =>
      new Response(JSON.stringify({ error: 'boom', message: `bad request ${init.body}` }), { status: 400, headers: { 'content-type': 'application/json' } })));
    const err = await createSl(appA.id).catch((e: unknown) => e as { message: string; extensions: Record<string, unknown> });
    const text = JSON.stringify({ m: err.message, e: err.extensions });
    expect(text).not.toContain('xoxb-secret-token');
    expect(text).not.toContain('xapp-secret-token');
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('Telegram: the key is scrubbed too', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body?: string }) =>
      new Response(JSON.stringify({ error: 'boom', message: `bad request ${init.body}` }), { status: 400, headers: { 'content-type': 'application/json' } })));
    const err = await createTg(appA.id).catch((e: unknown) => e as { message: string; extensions: Record<string, unknown> });
    const text = JSON.stringify({ m: err.message, e: err.extensions });
    expect(text).not.toContain('SECRET-tg');
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('#4829 every credential is part of the key', () => {
  const keyFor = async (create: () => Promise<unknown>) => {
    let key = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body?: string }) => {
      key = (JSON.parse(init.body ?? '{}') as { registrationKey: string }).registrationKey;
      return new Response(JSON.stringify({ error: 'x', message: 'x' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }));
    await create().catch(() => undefined);
    return key;
  };
  const sl = (botToken: string, appToken: string) => () =>
    resolvers.Mutation.createSlackConnection({}, { orgRef: org.id, appRef: appA.id, botToken, appToken }, ctxFor(admin.id));

  it('Slack: the same bot token with a different app token produces a different key (no adoption)', async () => {
    const a = await keyFor(sl('xoxb-same', 'xapp-one'));
    const b = await keyFor(sl('xoxb-same', 'xapp-two'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(await keyFor(sl('xoxb-same', 'xapp-one'))).toBe(a);
  });
});

describe('toolRegistrationKey', () => {
  it('refuses a missing appId and counts bytes, not UTF-16 units', () => {
    expect(() => toolRegistrationKey('slack', '', ['x'])).toThrow(/appId/);
    expect(toolRegistrationKey('p', 'a', ['é'])).toMatch(/^[0-9a-f]{64}$/);
    expect(toolRegistrationKey('p', 'a', ['é', 'b'])).not.toBe(toolRegistrationKey('p', 'a', ['éb']));
  });

  it('is deterministic, separates App, provider and credentials, and cannot be forged by shifting a boundary', () => {
    const k = toolRegistrationKey('slack', 'app-1', ['xoxb-a', 'xapp-b']);
    expect(k).toBe(toolRegistrationKey('slack', 'app-1', ['xoxb-a', 'xapp-b']));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toBe(toolRegistrationKey('slack', 'app-2', ['xoxb-a', 'xapp-b']));
    expect(k).not.toBe(toolRegistrationKey('telegram', 'app-1', ['xoxb-a', 'xapp-b']));
    expect(k).not.toBe(toolRegistrationKey('slack', 'app-1', ['xoxb-a', 'xapp-c']));
    expect(toolRegistrationKey('p', 'ab', ['c'])).not.toBe(toolRegistrationKey('p', 'a', ['bc']));
    expect(k).not.toContain('xoxb');
  });
});
