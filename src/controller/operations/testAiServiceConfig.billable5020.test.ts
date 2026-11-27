/**
 * hadron-server#5020 (Billing A13): who a configuration test bills (hrn:node:hadronmemory.com:specs:cor:dmo:170:05). The
 * billable account is the owner of the work, never the caller's active organization. A local capture server stands in for
 * the provider; no real provider, no real key.
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

const COMPLETION = {
  id: 'c1', object: 'chat.completion', created: 0, model: 'GLM-5.3',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(COMPLETION));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const M = resolvers.Mutation as unknown as {
  testAiServiceConfig: (p: unknown, a: { id: string; override?: Record<string, unknown> }, c: Context) => Promise<Record<string, any>>;
};
const ctxFor = (userId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], userId, ...extra }) as Context;
const mkConfig = (data: Record<string, unknown>) =>
  db.aiServiceConfig.create({
    data: {
      name: `cfg-${generateId().slice(-6).toLowerCase()}`, provider: 'glm', model: 'GLM-5.3', endpoint: `${origin}/api/paas/v4`,
      apiKeyEncrypted: encryptToken('sk-saved-0123456789'), apiKeyPreview: '…6789', ...data,
    } as never,
  });

let orgA: string, orgB: string, person: string, adminA: string, platformAdmin: string;
beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  resetAiConfigTestLimiter();
  orgA = (await db.organization.create({ data: { id: generateId(), name: 'b5020c-a', urn: 'b5020c-a' } })).id;
  orgB = (await db.organization.create({ data: { id: generateId(), name: 'b5020c-b', urn: 'b5020c-b' } })).id;
  person = (await db.user.create({ data: { id: generateId(), handle: 'b5020c-person', githubId: 502001 } })).id;
  adminA = (await db.user.create({ data: { id: generateId(), handle: 'b5020c-admin-a', githubId: 502002 } })).id;
  platformAdmin = (await db.user.create({ data: { id: generateId(), handle: 'b5020c-platform', githubId: 502003, roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA, userId: person, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA, userId: adminA, role: 'ADMIN' } });
  await db.aiModelPrice.create({
    data: { id: generateId(), provider: 'glm', model: 'GLM-5.3', tier: 1, inputMicroCentsPerMTok: 30_000_000n, outputMicroCentsPerMTok: 150_000_000n, effectiveAt: new Date('2026-01-01') },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pin 2: a test of a configuration on a person\'s App bills that person, not the caller\'s active organization', () => {
  it('records billableUserId = the person, organizationId null, and writes no debit', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    const app = await db.app.create({ data: { id: generateId(), name: 'p-app', urn: 'hrn:app:b5020c.test:p-app', ownerUserId: person } });
    const cfg = await mkConfig({ appId: app.id });
    const r = await M.testAiServiceConfig({}, { id: cfg.id }, ctxFor(person, { organizationId: orgA }));
    expect(r.ok).toBe(true);
    const event = await db.usageEvent.findFirstOrThrow({ where: { type: 'ai-config-test' } });
    expect(event).toMatchObject({ billableUserId: person, organizationId: null, userId: person });
    // its own key: nothing is debited
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});

describe('pin 3: a platform admin\'s test of the platform\'s own configuration has no billable account', () => {
  it('records neither column and writes no ledger entry, with debits on, a price row and an active organization', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://test.hadron.local' } });
    // a platform-owned config that runs on the platform's key (a saved key of the platform is the platform's, keyOwnerType HADRON_SERVER)
    const cfg = await mkConfig({ hadronServerId: host.id });
    const r = await M.testAiServiceConfig({}, { id: cfg.id }, ctxFor(platformAdmin, { roles: ['ADMIN'], organizationId: orgA }));
    expect(r.ok).toBe(true);
    const event = await db.usageEvent.findFirstOrThrow({ where: { type: 'ai-config-test' } });
    expect(event.keyOwnerType).toBe('HADRON_SERVER');
    expect(event).toMatchObject({ organizationId: null, billableUserId: null });
    expect(await db.creditLedgerEntry.count()).toBe(0);
    // ruling 2: the quota is reserved exactly as before, from the caller's active organization
    const counter = await db.quotaCounter.findFirstOrThrow({ where: { scopeId: orgA, action: 'llm.tokens' } });
    expect(counter.used).toBe(13);
  });
});

describe('pin 12 (guards, green on main): an organization\'s configuration bills that organization', () => {
  it('a test of an organization-owned configuration records that organization, not the caller\'s active one', async () => {
    const cfg = await mkConfig({ organizationId: orgB });
    // adminA is a member of orgA only; a platform admin may test orgB's configuration
    const r = await M.testAiServiceConfig({}, { id: cfg.id }, ctxFor(platformAdmin, { roles: ['ADMIN'], organizationId: orgA }));
    expect(r.ok).toBe(true);
    const event = await db.usageEvent.findFirstOrThrow({ where: { type: 'ai-config-test' } });
    expect(event).toMatchObject({ organizationId: orgB, billableUserId: null });
  });

  it('a test of a configuration on an organization\'s App records the App\'s organization', async () => {
    const app = await db.app.create({ data: { id: generateId(), name: 'a-app', urn: 'hrn:app:b5020c.test:a-app', organizationId: orgA } });
    const cfg = await mkConfig({ appId: app.id });
    await M.testAiServiceConfig({}, { id: cfg.id }, ctxFor(adminA, { organizationId: orgA }));
    const event = await db.usageEvent.findFirstOrThrow({ where: { type: 'ai-config-test' } });
    expect(event).toMatchObject({ organizationId: orgA, billableUserId: null });
  });
});
