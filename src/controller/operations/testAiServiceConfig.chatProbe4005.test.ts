/**
 * #4005 — the chat probe leg of testAiServiceConfig and the server-owned
 * tool-choice decision. A local capture server stands in for the provider
 * (intercepted transport); no real provider, no real key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { encryptToken } from '../../lib/tokenCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { assertModelBuildable, generateText } from '../../lib/llm/index.js';
import { chatToolChoiceFor, RESPOND_ONCE_INSTRUCTION, sdkToolChoiceFor } from '../../lib/llm/chatToolChoice.js';
import { listChatAiConfigChoices } from '../../lib/chatbotAiConfig.js';
import { defaultQuotaLimit, recordQuotaUsage } from '../../jobs/appRuns.js';
import {
  testAiServiceConfig,
  AI_CONFIG_CHAT_PROBE_MAX_TOKENS,
  AI_CONFIG_TEST_LIMIT,
  AI_CONFIG_TEST_PROBE_MAX_TOKENS,
  AI_CONFIG_TEST_TOKEN_RESERVE,
  resetAiConfigTestLimiter,
  type AiConfigTestDeps,
} from './testAiServiceConfig.js';

const SAVED_KEY = 'sk-saved-chat-4005-0123456789';
const SENTINEL = 'PROVIDER-TEXT-SENTINEL-4005';

type Captured = { path: string; auth: string | undefined; body: Record<string, any> };
let server: Server;
let origin: string;
const captured: Captured[] = [];
const hanging: Array<import('node:http').ServerResponse> = [];
/** What the provider answers to a request that carries tools (the chat leg). */
let chatAnswer: (c: Captured) => { status?: number; json: unknown } = () => ({ json: {} });

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
/** An OpenAI chat completion with the given tool calls. */
const oaCalls = (calls: Array<{ name: string; args: unknown }>, content: string | null = null) => ({
  id: 'c-1', object: 'chat.completion', created: 0, model: 'm',
  choices: [{
    index: 0,
    message: {
      role: 'assistant', content,
      ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })) } : {}),
    },
    finish_reason: calls.length ? 'tool_calls' : 'stop',
  }],
  usage,
});
const OK_ARGS = { message: 'hello', onTrack: true };
const PLAIN = oaCalls([], 'OK');
const anthropicCall = (name: string, input: unknown) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_sequence: null,
  content: [{ type: 'tool_use', id: 'tu_1', name, input }],
  usage: { input_tokens: 20, output_tokens: 5 },
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const c: Captured = { path: req.url ?? '', auth: req.headers.authorization, body: await readBody(req) };
    captured.push(c);
    res.setHeader('content-type', 'application/json');
    if (c.path.startsWith('/hang/')) { hanging.push(res); return; }
    const isChat = Array.isArray(c.body.tools);
    const isAnthropic = c.path.startsWith('/anthropic');
    if (!isChat) {
      res.end(JSON.stringify(isAnthropic
        ? { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }
        : PLAIN));
      return;
    }
    const a = chatAnswer(c);
    res.statusCode = a.status ?? 200;
    res.end(JSON.stringify(a.json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const res of hanging) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let org: { id: string };
let admin: { id: string };
let member: { id: string };
const ctxFor = (userId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], userId, ...extra }) as Context;
const M = resolvers.Mutation as unknown as {
  testAiServiceConfig: (p: unknown, a: { id: string; override?: Record<string, unknown>; chatProbe?: boolean }, c: Context) => Promise<Record<string, any>>;
};
const run = (id: string, ctx: Context, chatProbe?: boolean, override?: Record<string, unknown>) =>
  M.testAiServiceConfig({}, { id, override, ...(chatProbe === undefined ? {} : { chatProbe }) }, ctx);

async function mkConfig(data: Record<string, unknown> = {}) {
  return db.aiServiceConfig.create({
    data: {
      name: `cfg-${generateId().slice(-6).toLowerCase()}`,
      provider: 'openai', model: 'gpt-4o', apiStyle: 'CHAT_COMPLETIONS',
      endpoint: `${origin}/v1`,
      apiKeyEncrypted: encryptToken(SAVED_KEY), apiKeyPreview: '…6789',
      organizationId: org.id,
      ...data,
    } as never,
  });
}
const anthropicCfg = (model: string) => mkConfig({ provider: 'anthropic', model, apiStyle: null, endpoint: `${origin}/anthropic` });

beforeEach(async () => {
  await cleanDb(db);
  captured.length = 0;
  chatAnswer = () => ({ json: oaCalls([{ name: 'respond', args: OK_ARGS }]) });
  resetAiConfigTestLimiter();
  org = await db.organization.create({ data: { id: generateId(), name: 'Acme', urn: `acme-4005-${Date.now()}` } });
  admin = await db.user.create({ data: { id: generateId(), handle: `t4005-admin-${Date.now()}`, githubId: 400501 } });
  member = await db.user.create({ data: { id: generateId(), handle: `t4005-member-${Date.now()}`, githubId: 400502 } });
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
    ],
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('the one predicate (cor:dmo:050:10: ids verbatim)', () => {
  it('auto for exactly the listed ids, forced for everything else', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) expect(chatToolChoiceFor('anthropic', m), m).toBe('AUTO');
    for (const m of ['anthropic.claude-sonnet-5-5', 'us.anthropic.claude-opus-5-5', 'global.anthropic.claude-fable-5-2']) expect(chatToolChoiceFor('bedrock', m), m).toBe('AUTO');
    const forced: Array<[string, string]> = [
      ['anthropic', 'claude-sonnet-5-5-x'], ['anthropic', 'Claude-Sonnet-5-5'], ['anthropic', 'claude-sonnet-5-5 '],
      ['anthropic', 'claude-haiku-5-5'], ['anthropic', 'claude-sonnet-5'], ['anthropic', ''],
      ['openai', 'claude-sonnet-5-5'], ['glm', 'claude-opus-5-5'], ['bedrock', 'claude-sonnet-5-5'],
      ['bedrock', 'anthropic.claude-sonnet-5-5-v1'], ['bedrock', 'US.anthropic.claude-sonnet-5-5'], ['anthropic', 'anthropic.claude-sonnet-5-5'],
      ['openai', 'gpt-4o'],
    ];
    for (const [p, m] of forced) expect(chatToolChoiceFor(p, m), `${p}/${m}`).toBe('FORCED');
    expect(sdkToolChoiceFor('AUTO')).toBe('auto');
    expect(sdkToolChoiceFor('FORCED')).toEqual({ type: 'tool', toolName: 'respond' });
  });

  it('is exposed on the ordinary chat choice list, with no key material, null for the default entry', async () => {
    const app = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: `acme-4005-${Date.now()}:a` } });
    const sonnet = await anthropicCfg('claude-sonnet-5-5').then((c) => db.aiServiceConfig.update({ where: { id: c.id }, data: { organizationId: null, appId: app.id } }));
    const other = await mkConfig({ organizationId: null, appId: app.id });
    const list = await listChatAiConfigChoices(db, app.id);
    expect(list.find((c) => c.isDefault)!.toolChoice).toBeNull();
    expect(list.find((c) => c.value === sonnet.id)!.toolChoice).toBe('AUTO');
    expect(list.find((c) => c.value === other.id)!.toolChoice).toBe('FORCED');
    expect(JSON.stringify(list)).not.toContain(SAVED_KEY);
  });
});

describe('run compatibility', () => {
  it('chatProbe absent or false: no chat result, ONE request, no tools on the wire, 16 tokens', async () => {
    const cfg = await mkConfig();
    for (const flag of [undefined, false]) {
      captured.length = 0;
      resetAiConfigTestLimiter();
      const r = await run(cfg.id, ctxFor(admin.id), flag);
      expect(r.chat).toBeNull();
      expect(r).toMatchObject({ ok: true, reply: 'OK' });
      expect(captured).toHaveLength(1);
      expect(captured[0].body.tools).toBeUndefined();
      expect(captured[0].body.max_tokens).toBe(AI_CONFIG_TEST_PROBE_MAX_TOKENS);
    }
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test-chat' } })).toBe(0);
  });
});

describe('the chat leg on the wire', () => {
  it('forced: the respond tool, a forced function choice, the 64 cap; the run leg first and unchanged', async () => {
    const cfg = await mkConfig();
    const r = await run(cfg.id, ctxFor(admin.id), true);
    expect(r).toMatchObject({ ok: true, reply: 'OK', chat: { status: 'PASS' } });
    expect(captured).toHaveLength(2);
    expect(captured[0].body.tools).toBeUndefined();
    expect(captured[0].body.max_tokens).toBe(16);
    const chat = captured[1].body;
    expect(chat.tools).toHaveLength(1);
    expect(chat.tools[0].function.name).toBe('respond');
    expect(chat.tools[0].function.parameters.required).toEqual(['message', 'onTrack']);
    expect(chat.tool_choice).toEqual({ type: 'function', function: { name: 'respond' } });
    expect(chat.max_tokens).toBe(AI_CONFIG_CHAT_PROBE_MAX_TOKENS);
    expect(JSON.stringify(chat)).not.toContain(RESPOND_ONCE_INSTRUCTION);
    expect(captured[1].auth).toBe(`Bearer ${SAVED_KEY}`);
  });

  it('a listed Sonnet id is sent tool_choice auto (non-strict) plus the respond-once instruction; controls stay forced', async () => {
    chatAnswer = () => ({ json: anthropicCall('respond', OK_ARGS) });
    const sonnet = await anthropicCfg('claude-sonnet-5-5');
    expect((await run(sonnet.id, ctxFor(admin.id), true)).chat).toEqual({ status: 'PASS' });
    const auto = captured[1].body;
    expect(auto.tool_choice).toEqual({ type: 'auto' });
    expect(JSON.stringify(auto.system)).toContain(RESPOND_ONCE_INSTRUCTION);
    expect(auto.tools[0].name).toBe('respond');
    for (const model of ['claude-sonnet-5-5-x', 'Claude-Sonnet-5-5', 'claude-haiku-5-5']) {
      captured.length = 0;
      resetAiConfigTestLimiter();
      const cfg = await anthropicCfg(model);
      await run(cfg.id, ctxFor(admin.id), true);
      expect(captured[1].body.tool_choice, model).toEqual({ type: 'tool', name: 'respond' });
      expect(JSON.stringify(captured[1].body.system ?? ''), model).not.toContain(RESPOND_ONCE_INSTRUCTION);
    }
  });

  it('the override model is judged, not the saved one (by-id/override identity); the stored row is untouched', async () => {
    chatAnswer = () => ({ json: anthropicCall('respond', OK_ARGS) });
    const cfg = await anthropicCfg('claude-haiku-5-5');
    await run(cfg.id, ctxFor(admin.id), true, { model: 'claude-opus-5-5' });
    expect(captured[1].body.tool_choice).toEqual({ type: 'auto' });
    const row = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: cfg.id } });
    expect(row.model).toBe('claude-haiku-5-5');
  });

  it('an override maxTokens never lifts either cap', async () => {
    const cfg = await mkConfig();
    await run(cfg.id, ctxFor(admin.id), true, { params: { maxTokens: 1_000_000 } });
    expect(captured.map((c) => c.body.max_tokens)).toEqual([16, 64]);
    captured.length = 0;
    resetAiConfigTestLimiter();
    await run(cfg.id, ctxFor(admin.id), true, { params: { maxTokens: 8 } });
    expect(captured.map((c) => c.body.max_tokens)).toEqual([8, 8]);
  });
});

describe('the outcome matrix', () => {
  const cases: Array<[string, () => { status?: number; json: unknown }, string]> = [
    ['exactly one valid respond', () => ({ json: oaCalls([{ name: 'respond', args: OK_ARGS }]) }), 'PASS'],
    ['an empty message is still a string', () => ({ json: oaCalls([{ name: 'respond', args: { message: '', onTrack: false } }]) }), 'PASS'],
    ['text only', () => ({ json: oaCalls([], SENTINEL) }), 'FAIL_TEXT_ONLY'],
    ['another tool', () => ({ json: oaCalls([{ name: 'other', args: OK_ARGS }]) }), 'FAIL_OTHER_TOOL'],
    ['two respond calls', () => ({ json: oaCalls([{ name: 'respond', args: OK_ARGS }, { name: 'respond', args: OK_ARGS }]) }), 'FAIL_MULTIPLE_CALLS'],
    ['a non-string message', () => ({ json: oaCalls([{ name: 'respond', args: { message: 7, onTrack: true } }]) }), 'FAIL_MALFORMED'],
    ['a missing required field', () => ({ json: oaCalls([{ name: 'respond', args: { message: 'x' } }]) }), 'FAIL_MALFORMED'],
    ['arguments that are not JSON', () => ({ json: oaCalls([{ name: 'respond', args: `{"message": ${SENTINEL}` }]) }), 'FAIL_MALFORMED'],
    ['a provider error', () => ({ status: 500, json: { error: { message: SENTINEL, type: 'server_error' } } }), 'FAIL_PROVIDER_UNAVAILABLE'],
  ];
  for (const [name, answer, want] of cases) {
    it(`${name} → ${want}`, async () => {
      chatAnswer = answer;
      const cfg = await mkConfig();
      const r = await run(cfg.id, ctxFor(admin.id), true);
      expect(r.chat).toEqual({ status: want });
      // The chat outcome is the closed status and nothing else.
      expect(JSON.stringify(r.chat)).not.toContain(SENTINEL);
      expect(JSON.stringify(r.chat)).not.toContain(SAVED_KEY);
      // The run outcome does not depend on the chat leg.
      expect(r).toMatchObject({ ok: true, reply: 'OK' });
    });
  }

  it('two calls fail under auto too, and a valid single call passes under auto', async () => {
    const cfg = await anthropicCfg('claude-opus-5-5');
    chatAnswer = () => ({ json: { ...anthropicCall('respond', OK_ARGS), content: [
      { type: 'tool_use', id: 'a', name: 'respond', input: OK_ARGS }, { type: 'tool_use', id: 'b', name: 'respond', input: OK_ARGS },
    ] } });
    expect((await run(cfg.id, ctxFor(admin.id), true)).chat).toEqual({ status: 'FAIL_MULTIPLE_CALLS' });
  });

  it('a provider that is not offered tools is UNSUPPORTED_PROVIDER: no chat request at all', async () => {
    const cfg = await mkConfig({ provider: 'glm', model: 'GLM-5.3', apiStyle: null, endpoint: `${origin}/api/paas/v4` });
    const r = await run(cfg.id, ctxFor(admin.id), true);
    expect(r.chat).toEqual({ status: 'UNSUPPORTED_PROVIDER' });
    expect(r.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test-chat' } })).toBe(0);
  });

  it('a hung provider is a failed chat leg inside the deadline, with no retry', async () => {
    const cfg = await mkConfig({ endpoint: `${origin}/hang/v1` });
    const deps: AiConfigTestDeps = { generate: async () => ({ text: 'OK', tokensIn: 1, tokensOut: 1, provider: 'openai', model: 'gpt-4o' }), now: () => Date.now(), timeoutMs: 300, preflight: assertModelBuildable };
    const t0 = Date.now();
    const r = await testAiServiceConfig(ctxFor(admin.id), cfg.id, {}, deps, true);
    expect(r.chat).toEqual({ status: 'FAIL_PROVIDER_UNAVAILABLE' });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(captured.filter((c) => Array.isArray(c.body.tools))).toHaveLength(1);
  });

  it('an internal throw while judging the call is NOT a provider failure: logged, rethrown after the usage row, nothing leaked', async () => {
    const cfg = await mkConfig();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps: AiConfigTestDeps = {
      generate: async () => ({ text: 'OK', tokensIn: 1, tokensOut: 1, provider: 'openai', model: 'gpt-4o' }),
      // a malformed result makes OUR classifier throw (calls is undefined)
      generateChat: (async () => ({ calls: undefined, tokensIn: 7, tokensOut: 3 })) as never,
      now: () => Date.now(), timeoutMs: 5_000, preflight: assertModelBuildable,
    };
    await expect(testAiServiceConfig(ctxFor(admin.id), cfg.id, {}, deps, true)).rejects.toBeInstanceOf(TypeError);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('chat probe internal error'))).toBe(true);
    // the call that DID happen is still metered, with what it spent
    const rows = await db.usageEvent.findMany({ where: { type: 'ai-config-test-chat' } });
    expect(rows).toHaveLength(1);
    spy.mockRestore();
  });

  it('a provider throw stays a closed provider failure and logs no internal error', async () => {
    const cfg = await mkConfig();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps: AiConfigTestDeps = {
      generate: async () => ({ text: 'OK', tokensIn: 1, tokensOut: 1, provider: 'openai', model: 'gpt-4o' }),
      generateChat: (async () => { throw new Error('upstream 503'); }) as never,
      now: () => Date.now(), timeoutMs: 5_000, preflight: assertModelBuildable,
    };
    const r = await testAiServiceConfig(ctxFor(admin.id), cfg.id, {}, deps, true);
    expect(r.chat).toEqual({ status: 'FAIL_PROVIDER_UNAVAILABLE' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a config with no key reports the closed status and makes no call', async () => {
    const cfg = await mkConfig({ apiKeyEncrypted: null, apiKeyPreview: null });
    const r = await run(cfg.id, ctxFor(admin.id), true);
    expect(r).toMatchObject({ ok: false, error: { code: 'NO_API_KEY' }, chat: { status: 'FAIL_PROVIDER_UNAVAILABLE' } });
    expect(captured).toEqual([]);
  });
});

describe('refusals make zero calls', () => {
  it('unauthorized, missing and impersonated: no request, no usage, no quota', async () => {
    const cfg = await mkConfig();
    await expect(run(cfg.id, ctxFor(member.id), true)).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
    await expect(run(generateId(), ctxFor(admin.id), true)).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
    const impersonating = ctxFor(admin.id, {
      impersonation: { sessionId: generateId(), actorUserId: member.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(run(cfg.id, impersonating, true)).rejects.toThrow(/Forbidden/);
    expect(captured).toEqual([]);
    expect(await db.usageEvent.count()).toBe(0);
    expect(await db.quotaCounter.count()).toBe(0);
  });
});

describe('spend accounting', () => {
  it('two separately metered attempts under ONE rate-limit unit', async () => {
    const cfg = await mkConfig();
    for (let i = 0; i < AI_CONFIG_TEST_LIMIT; i++) expect((await run(cfg.id, ctxFor(admin.id), true)).chat.status).toBe('PASS');
    await expect(run(cfg.id, ctxFor(admin.id), true)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
    expect(captured).toHaveLength(AI_CONFIG_TEST_LIMIT * 2);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(AI_CONFIG_TEST_LIMIT);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test-chat' } })).toBe(AI_CONFIG_TEST_LIMIT);
  });

  it('a platform-funded chat leg reserves 64+64 and settles to what it spent, in addition to the run leg', async () => {
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ organizationId: null, hadronServerId: host.id });
    const r = await run(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }), true);
    expect(r.chat).toEqual({ status: 'PASS' });
    const events = await db.usageEvent.findMany({ where: { type: { in: ['ai-config-test', 'ai-config-test-chat'] } } });
    expect(events.map((e) => [e.type, e.keyOwnerType, e.organizationId, (e.tokensIn ?? 0) + (e.tokensOut ?? 0)]).sort()).toEqual([
      ['ai-config-test', 'HADRON_SERVER', org.id, 25],
      ['ai-config-test-chat', 'HADRON_SERVER', org.id, 25],
    ]);
    expect((await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } })).used).toBe(50);
  });

  it('the chat reservation is 128: room for the run leg but not the chat leg → the chat leg is refused, no chat request', async () => {
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ organizationId: null, hadronServerId: host.id });
    const limit = defaultQuotaLimit('org', 'llm.tokens');
    const runReserve = AI_CONFIG_TEST_TOKEN_RESERVE + AI_CONFIG_TEST_PROBE_MAX_TOKENS; // 80
    const chatReserve = AI_CONFIG_TEST_TOKEN_RESERVE + AI_CONFIG_CHAT_PROBE_MAX_TOKENS; // 128
    expect([runReserve, chatReserve]).toEqual([80, 128]);
    // The run leg reserves 80 (fits) and settles to the 25 it spent, leaving 100 of room: under 128.
    await recordQuotaUsage(db, 'org', org.id, 'llm.tokens', limit, limit - 125);
    const r = await run(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }), true);
    expect(r.ok).toBe(true);
    expect(r.chat).toEqual({ status: 'FAIL_PROVIDER_UNAVAILABLE' });
    expect(captured.filter((c) => Array.isArray(c.body.tools))).toHaveLength(0);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test-chat' } })).toBe(0);
  });
});
