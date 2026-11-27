/**
 * hadron-server#5023 (Billing A3), gate point 3 (gate ruling 5, cor:acl:050:05): a configuration test on the platform's own key
 * with an active organization at zero credit is NOT refused: after A13 that test has no billable account, and work with no
 * billable account is never gated. The helper is still reached once, with no owner, so the check stays uniform.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { encryptToken } from '../../lib/tokenCrypto.js';
import { clearPriceCache } from '../../lib/metering/index.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { resetAiConfigTestLimiter } from './testAiServiceConfig.js';

const spy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../lib/metering/gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/metering/gate.js')>();
  return { ...real, gateCredit: vi.fn(async (...args: Parameters<typeof real.gateCredit>) => { spy.calls.push(args.slice(1)); return real.gateCredit(...args); }) };
});

const COMPLETION = {
  id: 'c1', object: 'chat.completion', created: 0, model: 'GLM-5.3',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};
let server: Server;
let origin: string;
let hits = 0;
beforeAll(async () => {
  server = createServer((req, res) => { req.resume(); hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(COMPLETION)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const M = resolvers.Mutation as unknown as {
  testAiServiceConfig: (p: unknown, a: { id: string }, c: Context) => Promise<Record<string, any>>;
};
let orgId: string, platformAdmin: string;
beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  resetAiConfigTestLimiter();
  hits = 0;
  spy.calls.length = 0;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cg-org', urn: 'cg-org' } })).id;
  platformAdmin = (await db.user.create({ data: { id: generateId(), handle: 'cg-platform', githubId: 502301, roles: ['ADMIN'] } })).id;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('pin 12: the platform\'s own configuration test is never refused for want of credit', () => {
  it('with debits and the gate on and the active organization at zero, the provider is called and the helper saw no owner', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('BILLING_CREDIT_GATE_ENABLED', 'true');
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://cg.hadron.local' } });
    const cfg = await db.aiServiceConfig.create({
      data: { name: 'cfg-cg', provider: 'glm', model: 'GLM-5.3', endpoint: `${origin}/api/paas/v4`, apiKeyEncrypted: encryptToken('sk-saved-0123456789'), apiKeyPreview: '…6789', hadronServerId: host.id } as never,
    });
    const ctx = { db, roles: ['ADMIN'], userId: platformAdmin, organizationId: orgId } as Context;
    const r = await M.testAiServiceConfig({}, { id: cfg.id }, ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(hits).toBe(1);
    expect(spy.calls).toEqual([['HADRON_SERVER', null]]); // reached once, with no billable account
  });
});
