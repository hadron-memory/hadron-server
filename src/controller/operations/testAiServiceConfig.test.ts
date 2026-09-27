/**
 * #1378 — testAiServiceConfig: by id, through the run's own client, key kept
 * server-side, saved vs override reported, metered, rate-limited. A local
 * capture server stands in for the provider; no real provider, no real key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { encryptToken } from '../../lib/tokenCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateText } from '../../lib/llm/index.js';
import { defaultQuotaLimit, recordQuotaUsage, reserveQuota } from '../../jobs/appRuns.js';
import {
  testAiServiceConfig,
  AI_CONFIG_TEST_LIMIT,
  AI_CONFIG_TEST_TOKEN_RESERVE,
  AI_CONFIG_TEST_WINDOW_MS,
  admitTest,
  aiConfigTestLimiterSize,
  resetAiConfigTestLimiter,
  scrub,
} from './testAiServiceConfig.js';

const SAVED_KEY = 'sk-saved-0123456789';
const OVERRIDE_KEY = 'sk-override-9876543210';

const CHAT_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'GLM-5.3',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

let server: Server;
const hanging: Array<import('node:http').ServerResponse> = [];
let origin: string;
const captured: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '';
    captured.push({ path, auth: req.headers.authorization, body: await readBody(req) });
    res.setHeader('content-type', 'application/json');
    if (path.startsWith('/hang/')) {
      // Accepts the request and never answers.
      hanging.push(res);
      return;
    }
    if (path.startsWith('/echo-key/')) {
      // A provider that echoes the bearer back in its error body.
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization}`, type: 'invalid_request_error' } }));
      return;
    }
    res.end(JSON.stringify(CHAT_COMPLETION));
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
  testAiServiceConfig: (p: unknown, a: { id: string; override?: Record<string, unknown> }, c: Context) => Promise<Record<string, any>>;
};
const test = (id: string, ctx: Context, override?: Record<string, unknown>) => M.testAiServiceConfig({}, { id, override }, ctx);

async function mkConfig(data: Record<string, unknown>) {
  return db.aiServiceConfig.create({
    data: {
      name: `cfg-${generateId().slice(-6).toLowerCase()}`,
      provider: 'glm',
      model: 'GLM-5.3',
      endpoint: `${origin}/api/paas/v4`,
      apiKeyEncrypted: encryptToken(SAVED_KEY),
      apiKeyPreview: '…6789',
      ...data,
    } as never,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  captured.length = 0;
  resetAiConfigTestLimiter();
  org = await db.organization.create({ data: { id: generateId(), name: 'Acme', urn: `acme-1378-${Date.now()}` } });
  admin = await db.user.create({ data: { id: generateId(), handle: `t1378-admin-${Date.now()}`, githubId: 137801 } });
  member = await db.user.create({ data: { id: generateId(), handle: `t1378-member-${Date.now()}`, githubId: 137802 } });
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
    ],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('testAiServiceConfig (#1378)', () => {
  it('tests the SAVED config by id through the run path: its endpoint, protocol and stored key', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    const r = await test(cfg.id, ctxFor(admin.id));
    expect(r).toMatchObject({
      ok: true,
      provider: 'glm',
      model: 'GLM-5.3',
      endpoint: `${origin}/api/paas/v4`,
      apiStyle: 'CHAT_COMPLETIONS',
      reply: 'OK',
      error: null,
      used: { provider: 'SAVED', model: 'SAVED', endpoint: 'SAVED', apiStyle: 'SAVED', key: 'SAVED' },
    });
    expect(captured.map((c) => c.path)).toEqual(['/api/paas/v4/chat/completions']);
    expect(captured[0].auth).toBe(`Bearer ${SAVED_KEY}`);
    expect(captured[0].body).toMatchObject({ model: 'GLM-5.3', max_tokens: 16 });
    // The key never leaves the server.
    expect(JSON.stringify(r)).not.toContain(SAVED_KEY);
  });

  it('override: null is the same as omitting it: the saved config, every field SAVED (portal#950 contract)', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    const r = await test(cfg.id, ctxFor(admin.id), null as never);
    expect(r).toMatchObject({ ok: true, used: { provider: 'SAVED', model: 'SAVED', endpoint: 'SAVED', apiStyle: 'SAVED', key: 'SAVED' } });
    expect(captured[0].auth).toBe(`Bearer ${SAVED_KEY}`);
  });

  it('an override tests edited values without saving them, and says so field by field', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    const r = await test(cfg.id, ctxFor(admin.id), { model: 'GLM-5.4', apiKey: OVERRIDE_KEY, endpoint: `${origin}/other/v4` });
    expect(r.used).toEqual({ provider: 'SAVED', model: 'OVERRIDE', endpoint: 'OVERRIDE', apiStyle: 'SAVED', key: 'OVERRIDE' });
    expect(captured[0]).toMatchObject({ path: '/other/v4/chat/completions', auth: `Bearer ${OVERRIDE_KEY}` });
    expect(JSON.stringify(r)).not.toContain(OVERRIDE_KEY);
    const row = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: cfg.id } });
    expect([row.model, row.endpoint]).toEqual(['GLM-5.3', `${origin}/api/paas/v4`]);
  });

  it('a config with no key reports NO_API_KEY without calling anyone or metering', async () => {
    const cfg = await mkConfig({ organizationId: org.id, apiKeyEncrypted: null, apiKeyPreview: null });
    const r = await test(cfg.id, ctxFor(admin.id));
    expect(r).toMatchObject({ ok: false, used: { key: 'NONE' }, error: { code: 'NO_API_KEY' } });
    expect(captured).toEqual([]);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(0);
  });

  it('an override that CLEARS the key (null or empty) tests as no key, as the save would', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    for (const apiKey of [null, '']) {
      const r = await test(cfg.id, ctxFor(admin.id), { apiKey });
      expect(r, String(apiKey)).toMatchObject({ ok: false, used: { key: 'NONE' }, error: { code: 'NO_API_KEY' } });
    }
    expect(captured).toEqual([]);
  });

  it('a short key is scrubbed too', async () => {
    const cfg = await mkConfig({ organizationId: org.id, endpoint: `${origin}/echo-key/v4`, apiKeyEncrypted: encryptToken('zq9') });
    const r = await test(cfg.id, ctxFor(admin.id));
    expect(r.error.message).toContain('[redacted]');
    expect(r.error.message).not.toContain('zq9');
  });

  it('an override is judged as the save would judge it: the resulting provider/params pair (#1385 review)', async () => {
    const cfg = await mkConfig({ organizationId: org.id, params: { reasoningEffort: 'extreme' } });
    await expect(test(cfg.id, ctxFor(admin.id), { provider: 'openai' })).rejects.toMatchObject({
      extensions: { code: 'UnknownAiProviderError' },
    });
    expect(captured).toEqual([]);
  });

  it('an empty model override is reported as an override, since it is what gets sent', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    const r = await test(cfg.id, ctxFor(admin.id), { model: '' });
    expect(r.used.model).toBe('OVERRIDE');
    expect(captured[0].body).toMatchObject({ model: '' });
  });

  it('an override key is tested even when the stored ciphertext no longer decrypts', async () => {
    const cfg = await mkConfig({ organizationId: org.id, apiKeyEncrypted: 'not-a-valid-ciphertext' });
    const r = await test(cfg.id, ctxFor(admin.id), { apiKey: OVERRIDE_KEY });
    expect(r).toMatchObject({ ok: true, used: { key: 'OVERRIDE' } });
    expect(captured[0].auth).toBe(`Bearer ${OVERRIDE_KEY}`);
  });

  it('a stored key that no longer decrypts is a failed test with a reason, not an internal error', async () => {
    const cfg = await mkConfig({ organizationId: org.id, apiKeyEncrypted: 'not-a-valid-ciphertext' });
    const r = await test(cfg.id, ctxFor(admin.id));
    expect(r).toMatchObject({ ok: false, used: { key: 'SAVED' }, error: { code: 'KEY_UNREADABLE', transient: false } });
    expect(captured).toEqual([]);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(0);
  });

  it('an endpoint that never answers is a failed, transient test within the deadline (#1385 review)', async () => {
    const cfg = await mkConfig({ organizationId: org.id, endpoint: `${origin}/hang/v4` });
    const started = Date.now();
    const r = await testAiServiceConfig(ctxFor(admin.id), cfg.id, {}, { generate: generateText, now: () => Date.now(), timeoutMs: 300, preflight: () => {} });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ ok: false, error: { code: 'LLM_CALL_FAILED', transient: true } });
    expect(captured.filter((c) => c.path.startsWith('/hang/'))).toHaveLength(1);
  });

  it('provider error text is scrubbed of the key before it is returned', async () => {
    const cfg = await mkConfig({ organizationId: org.id, endpoint: `${origin}/echo-key/v4` });
    const r = await test(cfg.id, ctxFor(admin.id));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('LLM_CALL_FAILED');
    expect(r.error.message).toContain('[redacted]');
    expect(JSON.stringify(r)).not.toContain(SAVED_KEY);
  });

  it('only the owner\'s admins may test, and never under impersonation', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    // An unmanageable config reads exactly like a missing one: no id oracle.
    await expect(test(cfg.id, ctxFor(member.id))).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
    // A realistic support session into this org: the owner gate alone would
    // admit it (the target is an org ADMIN), so this pins the explicit refusal.
    const impersonating = ctxFor(admin.id, {
      impersonation: { sessionId: generateId(), actorUserId: member.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(test(cfg.id, impersonating)).rejects.toThrow(/Forbidden/);
    await expect(test(generateId(), ctxFor(admin.id))).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
    expect(captured).toEqual([]);
  });

  it('an override is validated as a write would be: a public http endpoint is refused before any call', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    await expect(test(cfg.id, ctxFor(admin.id), { endpoint: 'http://api.z.ai/v4' })).rejects.toMatchObject({
      extensions: { code: 'AiConfigValidationError' },
    });
    await expect(test(cfg.id, ctxFor(admin.id), { provider: 'anthropic', apiStyle: 'RESPONSES' })).rejects.toMatchObject({
      extensions: { code: 'AiConfigValidationError' },
    });
    expect(captured).toEqual([]);
  });

  it('every test is metered; a BYOK test is the owner\'s, an override key is the caller\'s own', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    await test(cfg.id, ctxFor(admin.id));
    await test(cfg.id, ctxFor(admin.id), { apiKey: OVERRIDE_KEY });
    const events = await db.usageEvent.findMany({ where: { type: 'ai-config-test' }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.keyOwnerType, e.organizationId, e.userId, e.tokensIn, e.tokensOut])).toEqual([
      ['ORGANIZATION', org.id, admin.id, 12, 1],
      [null, org.id, admin.id, 12, 1],
    ]);
    // BYOK never counts against the platform allowance.
    expect(await db.quotaCounter.count()).toBe(0);
  });

  it('a platform-key test counts against the org\'s daily token quota', async () => {
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    const platformAdmin = ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id });
    const r = await test(cfg.id, platformAdmin);
    expect(r.ok).toBe(true);
    const event = await db.usageEvent.findFirstOrThrow({ where: { type: 'ai-config-test' } });
    expect([event.keyOwnerType, event.organizationId]).toEqual(['HADRON_SERVER', org.id]);
    const counter = await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } });
    expect(counter.used).toBe(13);
  });

  describe('a keyless config at a default host (#1385 review)', () => {
    const AMBIENT = 'sk-SERVER-AMBIENT-0123';
    // The official OpenAI client honours OPENAI_BASE_URL, so the capture
    // server stands in for api.openai.com without an explicit endpoint.
    const ambient = () => {
      vi.stubEnv('OPENAI_API_KEY', AMBIENT);
      vi.stubEnv('OPENAI_BASE_URL', `${origin}/v1`);
    };
    const keyless = { provider: 'openai', endpoint: null, apiStyle: 'CHAT_COMPLETIONS', apiKeyEncrypted: null, apiKeyPreview: null };

    it('a HADRON_SERVER config runs on the server credential, as a run would, and is platform-funded', async () => {
      ambient();
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ ...keyless, hadronServerId: host.id });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }));
      // The endpoint reported is the one the SDK used (OPENAI_BASE_URL), not
      // the catalog's api.openai.com.
      expect(r).toMatchObject({ ok: true, endpoint: `${origin}/v1`, used: { key: 'PLATFORM' }, error: null });
      expect(captured.map((c) => [c.path, c.auth])).toEqual([['/v1/chat/completions', `Bearer ${AMBIENT}`]]);
      expect(JSON.stringify(r)).not.toContain(AMBIENT);
      const event = await db.usageEvent.findFirstOrThrow({ where: { type: 'ai-config-test' } });
      expect(event.keyOwnerType).toBe('HADRON_SERVER');
    });

    it('an edit clearing a HADRON_SERVER key tests on the server credential, never the stored key', async () => {
      ambient();
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ ...keyless, apiKeyEncrypted: encryptToken(SAVED_KEY), hadronServerId: host.id });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }), { apiKey: '' });
      expect(r).toMatchObject({ ok: true, used: { key: 'PLATFORM' } });
      expect(captured.map((c) => c.auth)).toEqual([`Bearer ${AMBIENT}`]);
    });

    it('a provider echoing the server credential back never hands it to the caller', async () => {
      ambient();
      vi.stubEnv('OPENAI_BASE_URL', `${origin}/echo-key/v1`);
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ ...keyless, hadronServerId: host.id });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }));
      expect(captured.map((c) => c.auth)).toEqual([`Bearer ${AMBIENT}`]);
      expect(r).toMatchObject({ ok: false, used: { key: 'PLATFORM' }, error: { code: 'LLM_CALL_FAILED' } });
      expect(r.error.message).toContain('[redacted]');
      expect(JSON.stringify(r)).not.toContain(AMBIENT);
    });

    it('a set but unparsable base URL is reported as unknown, not as the catalog host (#1385 review)', async () => {
      ambient();
      vi.stubEnv('OPENAI_BASE_URL', 'not a url');
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ ...keyless, hadronServerId: host.id });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }));
      expect(r.endpoint).toBeNull();
    });

    it('with no process credential set, it is NO_API_KEY before anything is charged (#1385 review)', async () => {
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('OPENAI_BASE_URL', `${origin}/v1`);
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ ...keyless, hadronServerId: host.id });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }));
      expect(r).toMatchObject({ ok: false, used: { key: 'NONE' }, error: { code: 'NO_API_KEY' } });
      expect(r.error.message).toMatch(/server has no OPENAI_API_KEY/);
      expect(captured).toEqual([]);
      expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(0);
      expect(await db.quotaCounter.count()).toBe(0);
      expect(aiConfigTestLimiterSize()).toBe(0);
    });

    it('an operator base URL is reported sanitized: no userinfo, query or fragment (#1385 review)', async () => {
      ambient();
      vi.stubEnv('OPENAI_BASE_URL', `http://user:hunter2@${origin.replace('http://', '')}/v1?token=s3cret#frag`);
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ ...keyless, hadronServerId: host.id });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }));
      expect(r.endpoint).toBe(`${origin}/v1`);
      expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cret/);
    });

    it('an org config never tests on the platform credential: NO_API_KEY, no call', async () => {
      ambient();
      const cfg = await mkConfig({ ...keyless, organizationId: org.id });
      const r = await test(cfg.id, ctxFor(admin.id));
      // No call, but the endpoint says where one would have gone.
      expect(r).toMatchObject({ ok: false, endpoint: `${origin}/v1`, used: { key: 'NONE' }, error: { code: 'NO_API_KEY' } });
      expect(captured).toEqual([]);
    });
  });

  it('a platform-funded test with the org token allowance used up is refused before any call (#1385 review)', async () => {
    const limit = defaultQuotaLimit('org', 'llm.tokens');
    await recordQuotaUsage(db, 'org', org.id, 'llm.tokens', limit, limit);
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }));
    expect(r).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', transient: true } });
    expect(captured).toEqual([]);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(0);
    // BYOK is not the platform's allowance: the same org's own-key config still tests.
    const own = await mkConfig({ organizationId: org.id });
    expect((await test(own.id, ctxFor(admin.id, { organizationId: org.id }))).ok).toBe(true);
  });

  it('only calls that reach a provider use up the rate limit (#1385 review)', async () => {
    const cfg = await mkConfig({ organizationId: org.id, apiKeyEncrypted: null, apiKeyPreview: null });
    for (let i = 0; i < AI_CONFIG_TEST_LIMIT + 2; i++) {
      expect((await test(cfg.id, ctxFor(admin.id))).error.code).toBe('NO_API_KEY');
    }
    expect((await test(cfg.id, ctxFor(admin.id), { apiKey: OVERRIDE_KEY })).ok).toBe(true);
  });

  it('reports the regional host a Bedrock probe went to, from the key used (#1385 review)', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ message: 'denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
    });
    try {
      const triple = JSON.stringify({ accessKeyId: 'AKIATEST', secretAccessKey: 'secret-test-value', region: 'eu-west-1' });
      const cfg = await mkConfig({ organizationId: org.id, provider: 'bedrock', model: 'anthropic.claude-x', endpoint: null, apiKeyEncrypted: encryptToken(triple) });
      const r = await test(cfg.id, ctxFor(admin.id));
      expect(urls[0]).toMatch(/^https:\/\/bedrock-runtime\.eu-west-1\.amazonaws\.com\//);
      expect(r.endpoint).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('scrubs the longest secret first, so a secret that prefixes another leaves no tail (#1385 review)', () => {
    const out = scrub('id AKIA123 secret AKIA123-very-secret-tail', ['AKIA123', 'AKIA123-very-secret-tail']);
    expect(out).toBe('id [redacted] secret [redacted]');
  });

  it('a config that cannot even be built is CONFIG_INVALID: no call, no usage row, no rate-limit slot (#1385 review)', async () => {
    const cfg = await mkConfig({ organizationId: org.id, provider: 'bedrock', model: 'anthropic.claude-x', endpoint: null, apiKeyEncrypted: encryptToken('not-json') });
    for (let i = 0; i < AI_CONFIG_TEST_LIMIT + 2; i++) {
      expect(await test(cfg.id, ctxFor(admin.id))).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID', transient: false } });
    }
    expect(captured).toEqual([]);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(0);
    expect(aiConfigTestLimiterSize()).toBe(0);
  });

  it('platform-funded tests RESERVE quota atomically: concurrent tests cannot both pass a nearly spent allowance (#1385 review)', async () => {
    const limit = defaultQuotaLimit('org', 'llm.tokens');
    // Room for exactly one reservation.
    await recordQuotaUsage(db, 'org', org.id, 'llm.tokens', limit, limit - AI_CONFIG_TEST_TOKEN_RESERVE - 10);
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    const [a, b] = await Promise.all([
      test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id })),
      test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id })),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)!.error.code).toBe('QUOTA_EXCEEDED');
    expect(captured).toHaveLength(1);
    // Settled to the real spend (13 tokens), the unused reservation returned.
    const counter = await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } });
    expect(counter.used).toBe(limit - AI_CONFIG_TEST_TOKEN_RESERVE - 10 + 13);
  });

  it('a platform Bedrock probe on the AWS credential chain withholds provider text it cannot redact (#1385 review)', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIACHAIN');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret');
    // A provider error echoing material the scrub has no copy of (as an
    // instance-role session token would be).
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ message: 'denied for token IQoJb3JpZ2luX2VjEChainOnly' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    try {
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ hadronServerId: host.id, provider: 'bedrock', model: 'anthropic.claude-x', endpoint: null, apiKeyEncrypted: null, apiKeyPreview: null });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }));
      expect(r).toMatchObject({ ok: false, used: { key: 'PLATFORM' }, error: { code: 'LLM_CALL_FAILED' } });
      expect(r.error.message).toMatch(/withheld/);
      expect(JSON.stringify(r)).not.toContain('IQoJb3JpZ2luX2VjEChainOnly');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a low stored allowance that fits the probe is still testable (#1385 review)', async () => {
    const limit = AI_CONFIG_TEST_TOKEN_RESERVE + 10;
    await db.quotaCounter.create({
      data: { id: generateId(), scopeKind: 'org', scopeId: org.id, action: 'llm.tokens', window: 'day', used: 0, limit, resetAt: new Date(Date.now() + 86_400_000) },
    });
    expect(AI_CONFIG_TEST_TOKEN_RESERVE).toBeLessThanOrEqual(64);
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }));
    expect(r.ok).toBe(true);
  });

  it('a reservation that lands in a window which expired mid-call is undone and taken from the new day (#1385 review)', async () => {
    const t0 = Date.now();
    // The current window ends 1ms after t0, with 20 of yesterday's tokens used.
    await db.quotaCounter.create({
      data: { id: generateId(), scopeKind: 'org', scopeId: org.id, action: 'llm.tokens', window: 'day', used: 20, limit: 10_000, resetAt: new Date(t0 + 1) },
    });
    // Midnight passes between the rollover check (t0: still current) and the expiry check (t0 + 2).
    let calls = 0;
    const clock = () => new Date(calls++ === 0 ? t0 : t0 + 2);
    const got = await reserveQuota(db, 'org', org.id, 'llm.tokens', 10_000, 64, clock);
    expect(got).not.toBeNull();
    const row = await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } });
    // Taken from the NEW day: rolled to 0, then reserved.
    expect(row.used).toBe(64);
    expect(row.resetAt.getTime()).toBeGreaterThan(t0 + 1000);
  });

  it('an expired window with no headroom is rolled, not refused: the new day has room (#1385 review)', async () => {
    const t0 = Date.now();
    await db.quotaCounter.create({
      data: { id: generateId(), scopeKind: 'org', scopeId: org.id, action: 'llm.tokens', window: 'day', used: 10_000, limit: 10_000, resetAt: new Date(t0 + 1) },
    });
    let calls = 0;
    const clock = () => new Date(calls++ === 0 ? t0 : t0 + 2); // midnight after the pre-check
    expect(await reserveQuota(db, 'org', org.id, 'llm.tokens', 10_000, 64, clock)).not.toBeNull();
    expect((await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } })).used).toBe(64);
  });

  it('encoded query secrets are redacted raw and decoded, and a value that fails to decode still is (#1385 review)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-SERVER-AMBIENT-0123');
    vi.stubEnv('OPENAI_BASE_URL', 'https://llm.example.test/v1?token=%73ecretX&odd=%E0%A4%A');
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { message: 'raw %73ecretX decoded secretX odd %E0%A4%A', type: 'invalid_request_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ hadronServerId: host.id, provider: 'openai', endpoint: null, apiStyle: 'CHAT_COMPLETIONS', apiKeyEncrypted: null, apiKeyPreview: null });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }));
      expect(JSON.stringify(r)).not.toMatch(/%73ecretX|secretX|%E0%A4%A/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('secret parts of an operator base URL are redacted one by one, even when echoed alone (#1385 review)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-SERVER-AMBIENT-0123');
    vi.stubEnv('OPENAI_BASE_URL', 'https://user:hunter2@llm.example.test/v1?token=s3cret');
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { message: 'bad token s3cret for password hunter2', type: 'invalid_request_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
      const cfg = await mkConfig({ hadronServerId: host.id, provider: 'openai', endpoint: null, apiStyle: 'CHAT_COMPLETIONS', apiKeyEncrypted: null, apiKeyPreview: null });
      const r = await test(cfg.id, ctxFor(admin.id, { roles: ['ADMIN'] }));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cret/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('excess beyond the reservation is charged to the reservation\'s window only, never to a new day (#1385 review)', async () => {
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    // The day turns mid-probe (new-day usage 50), and the provider then
    // reports MORE than the reservation.
    const heavy = async () => {
      await db.quotaCounter.updateMany({
        where: { scopeId: org.id, action: 'llm.tokens' },
        data: { used: 50, resetAt: new Date(Date.now() + 2 * 86_400_000) },
      });
      return { text: 'OK', tokensIn: AI_CONFIG_TEST_TOKEN_RESERVE + 30, tokensOut: 10, provider: 'glm', model: 'GLM-5.3' } as never;
    };
    const r = await testAiServiceConfig(ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }), cfg.id, {}, {
      generate: heavy,
      now: () => Date.now(),
      timeoutMs: 5_000,
      preflight: () => {},
    });
    expect(r.ok).toBe(true);
    expect((await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } })).used).toBe(50);
  });

  it('excess within the same window is charged (#1385 review)', async () => {
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    const heavy = async () => ({ text: 'OK', tokensIn: AI_CONFIG_TEST_TOKEN_RESERVE + 30, tokensOut: 10, provider: 'glm', model: 'GLM-5.3' }) as never;
    await testAiServiceConfig(ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }), cfg.id, {}, {
      generate: heavy,
      now: () => Date.now(),
      timeoutMs: 5_000,
      preflight: () => {},
    });
    expect((await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } })).used).toBe(AI_CONFIG_TEST_TOKEN_RESERVE + 40);
  });

  it('a reservation is only released into the window it was taken from: a rollover mid-probe keeps the new day\'s usage (#1385 review)', async () => {
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    const cfg = await mkConfig({ hadronServerId: host.id });
    const rollover = async (resolved: Parameters<typeof generateText>[0], req: Parameters<typeof generateText>[1]) => {
      // The day turns while the provider answers: the counter resets and
      // records 50 tokens of NEW-day usage.
      await db.quotaCounter.updateMany({
        where: { scopeId: org.id, action: 'llm.tokens' },
        data: { used: 50, resetAt: new Date(Date.now() + 2 * 86_400_000) },
      });
      return generateText(resolved, req);
    };
    const r = await testAiServiceConfig(ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }), cfg.id, {}, {
      generate: rollover,
      now: () => Date.now(),
      timeoutMs: 5_000,
      preflight: () => {},
    });
    expect(r.ok).toBe(true);
    const counter = await db.quotaCounter.findFirstOrThrow({ where: { scopeId: org.id, action: 'llm.tokens' } });
    expect(counter.used).toBe(50);
  });

  it('the limiter forgets stale caller/config pairs instead of growing forever', () => {
    for (let i = 0; i < 1000; i++) admitTest(`u:${i}`, 0);
    expect(aiConfigTestLimiterSize()).toBe(1000);
    // Past the window, the next admission sweeps every stale pair.
    admitTest('fresh', AI_CONFIG_TEST_WINDOW_MS + 1);
    expect(aiConfigTestLimiterSize()).toBe(1);
  });

  it('is rate-limited per caller and config', async () => {
    const cfg = await mkConfig({ organizationId: org.id });
    for (let i = 0; i < AI_CONFIG_TEST_LIMIT; i++) expect((await test(cfg.id, ctxFor(admin.id))).ok).toBe(true);
    let caught: GraphQLError | null = null;
    try {
      await test(cfg.id, ctxFor(admin.id));
    } catch (e) {
      caught = e as GraphQLError;
    }
    expect(caught?.extensions).toMatchObject({ code: 'RATE_LIMITED' });
    expect(captured).toHaveLength(AI_CONFIG_TEST_LIMIT);
  });
});
