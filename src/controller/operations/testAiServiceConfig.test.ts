/**
 * #1378 — testAiServiceConfig: by id, through the run's own client, key kept
 * server-side, saved vs override reported, metered, rate-limited. A local
 * capture server stands in for the provider; no real provider, no real key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { encryptToken } from '../../lib/tokenCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { AI_CONFIG_TEST_LIMIT, resetAiConfigTestLimiter } from './testAiServiceConfig.js';

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
    await expect(test(cfg.id, ctxFor(member.id))).rejects.toThrow();
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
