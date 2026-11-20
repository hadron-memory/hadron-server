/**
 * #4170 — testAiServiceConfig on a `kimi` config. Intercepted transport only
 * (a local capture server); no Moonshot host, no real key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { encryptToken } from '../../lib/tokenCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { resetAiConfigTestLimiter, aiConfigTestLimiterSize } from './testAiServiceConfig.js';

const SENTINEL = 'sk-SERVER-AMBIENT-SENTINEL-4170';
const COMPLETION = {
  id: 'c', object: 'chat.completion', created: 0, model: 'kimi-k2',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

let server: Server;
let origin: string;
const captured: Array<{ path: string; auth: string | undefined; hasTools: boolean }> = [];
let org: { id: string };
let admin: { id: string };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    captured.push({ path: req.url ?? '', auth: req.headers.authorization, hasTools: Array.isArray(body.tools) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(COMPLETION));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ctxFor = (userId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], userId, ...extra }) as Context;
const M = resolvers.Mutation as unknown as {
  testAiServiceConfig: (p: unknown, a: { id: string; chatProbe?: boolean }, c: Context) => Promise<Record<string, any>>;
};

async function mkKimi(data: Record<string, unknown> = {}) {
  return db.aiServiceConfig.create({
    data: {
      name: `kimi-${generateId().slice(-6).toLowerCase()}`,
      provider: 'kimi', model: 'kimi-k2', apiStyle: null, endpoint: `${origin}/v1`,
      apiKeyEncrypted: encryptToken('kimi-saved-key'), apiKeyPreview: '…-key',
      organizationId: org.id,
      ...data,
    } as never,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  captured.length = 0;
  resetAiConfigTestLimiter();
  org = await db.organization.create({ data: { id: generateId(), name: 'Acme', urn: `acme-4170-${Date.now()}` } });
  admin = await db.user.create({ data: { id: generateId(), handle: `t4170-admin-${Date.now()}`, githubId: 417001 } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});
afterEach(() => vi.unstubAllEnvs());

describe('#4170 testAiServiceConfig on kimi', () => {
  it('a keyless kimi config is NO_API_KEY before any request, charge or limiter slot; the process key never appears', async () => {
    vi.stubEnv('OPENAI_API_KEY', SENTINEL);
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    for (const owner of [{ organizationId: org.id }, { hadronServerId: host.id }]) {
      const cfg = await mkKimi({ apiKeyEncrypted: null, apiKeyPreview: null, endpoint: null, organizationId: null, ...owner });
      const r = await M.testAiServiceConfig({}, { id: cfg.id }, ctxFor(admin.id, { roles: ['ADMIN'], organizationId: org.id }));
      expect(r).toMatchObject({ ok: false, used: { key: 'NONE' }, error: { code: 'NO_API_KEY' } });
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    }
    expect(captured).toEqual([]);
    expect(await db.usageEvent.count({ where: { type: 'ai-config-test' } })).toBe(0);
    expect(await db.quotaCounter.count()).toBe(0);
    expect(aiConfigTestLimiterSize()).toBe(0);
  });

  it('the plain probe sends the saved key to the endpoint; the chat probe is UNSUPPORTED_PROVIDER with no tools request', async () => {
    const cfg = await mkKimi();
    const r = await M.testAiServiceConfig({}, { id: cfg.id, chatProbe: true }, ctxFor(admin.id));
    expect(r.chat).toEqual({ status: 'UNSUPPORTED_PROVIDER' });
    expect(captured.map((c) => [c.path, c.auth, c.hasTools])).toEqual([['/v1/chat/completions', 'Bearer kimi-saved-key', false]]);
  });
});
