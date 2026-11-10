/** #3834 / ruling0266, cor:acl:140:01 and :09: write-path bounds, never a new terms grammar. */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { dropTestActions, insertGrant, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantTermsBytes, grantTermsHash } from '../../../lib/grants/terms.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
let http: Server, base: string, w: World, sessionId: string, key: string;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServer());
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => http.close(() => r()));
  await cleanDb(db); await dropTestActions(); await upsertPlatformActions(db); vi.unstubAllEnvs();
});
beforeEach(async () => {
  await cleanDb(db); w = await seedWorld(); await upsertPlatformActions(db);
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'CONTRIBUTOR' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  key = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: w.userId, oauthScopes: [], keyHash: hashUserApiKey(key), keyPreview: key.slice(-4) } });
});
async function post(query: string, variables: Record<string, unknown>): Promise<any> {
  return (await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-hadron-session': sessionId }, body: JSON.stringify({ query, variables }) })).json();
}
const ids = (n: number) => Array.from({ length: n }, () => generateId());
const input = (over: Record<string, unknown> = {}) => ({ action: 'schedule.create', holderKind: 'WORKER', holderRef: w.workerId, values: { entryNode: generateId() }, reason: 'because', ...over });
const create = (i: Record<string, unknown>) => post('mutation($i:CreateGrantInput!){createGrant(input:$i){id reason values}}', { i });
async function counts() {
  return db.$queryRaw`SELECT (SELECT count(*) FROM grants)::int AS grants,
    (SELECT count(*) FROM grant_events)::int AS events,
    (SELECT count(*) FROM grant_signing_requests)::int AS requests`;
}

describe('#3834 grant write bounds over real GraphQL', () => {
  it.each(['a', '😀'])('accepts exactly 2000 Unicode characters (%s), preserving the stored text', async char => {
    const reason = char.repeat(2000), r = await create(input({ reason }));
    expect(r.errors).toBeUndefined(); expect(r.data.createGrant.reason).toBe(reason);
    const rows = await db.$queryRaw<Array<{ reason: string }>>`SELECT reason FROM grants WHERE id=${r.data.createGrant.id}`;
    expect(rows).toEqual([{ reason }]);
  });
  it.each(['a', '😀'])('refuses 2001 Unicode characters (%s) with the limit, no value echo and no writes', async char => {
    const reason = char.repeat(2001), before = await counts();
    const r = await create(input({ reason }));
    expect(r.errors?.[0]?.extensions.code).toBe('GRANT_TERMS_INVALID');
    expect(r.errors[0].message).toMatch(/2,?000/); expect(JSON.stringify(r.errors)).not.toContain(reason);
    expect(await counts()).toEqual(before);
  });
  it.each(['schedule.create', 'webhook.create'])('%s accepts 100 entries unchanged', async action => {
    const values = { entryNode: ids(100) }, r = await create(input({ action, values }));
    expect(r.errors).toBeUndefined(); expect(r.data.createGrant.values).toEqual(values);
    const rows = await db.$queryRaw<Array<{ values: unknown }>>`SELECT action_values AS values FROM grants WHERE id=${r.data.createGrant.id}`;
    expect(rows).toEqual([{ values }]);
  });
  it.each(['schedule.create', 'webhook.create'])('%s refuses 101 entries with the limit, no value echo and no writes', async action => {
    const values = { entryNode: ids(101) }, before = await counts();
    const r = await create(input({ action, values }));
    expect(r.errors?.[0]?.extensions.code).toBe('GRANT_VALUES_INVALID');
    expect(r.errors[0].message).toContain('100');
    for (const id of values.entryNode) expect(JSON.stringify(r.errors)).not.toContain(id);
    expect(await counts()).toEqual(before);
  });
  it('bounds each parameter separately, not the sum of lists', async () => {
    // Synthetic two-parameter declaration exercises the generic per-parameter rule; no registry change ships.
    const parameters = [{ name: 'entryNode', type: 'node-ref', refusesWildcard: true }, { name: 'otherNode', type: 'node-ref', refusesWildcard: true }];
    await db.$executeRaw`UPDATE actions SET parameters=${JSON.stringify(parameters)}::jsonb WHERE name='schedule.create'`;
    const values = { entryNode: ids(100), otherNode: ids(100) };
    const r = await create(input({ values }));
    expect(r.errors).toBeUndefined(); expect(r.data.createGrant.values).toEqual(values);
    const before = await counts();
    const refused = await create(input({ values: { ...values, otherNode: ids(101) } }));
    expect(refused.errors?.[0]?.extensions.code).toBe('GRANT_VALUES_INVALID');
    expect(await counts()).toEqual(before);
  });
  it('an already-stored oversized grant keeps its exact terms and can still request a signature', async () => {
    const reason = 'legacy reason '.repeat(200), values = { entryNode: ids(101) };
    const id = await insertGrant(w, { user_id: null, worker_id: w.workerId, action: 'schedule.create', action_values: values, reason });
    const terms = { appId: w.appId, holder: { kind: 'worker' as const, id: w.workerId }, action: 'schedule.create', values, startsAt: null, expiresAt: null, maxUses: null, reason };
    expect(grantTermsBytes(terms).toString('utf8')).toContain(`reason ${JSON.stringify(reason)}\n`);
    const r = await post('mutation($id:ID!){requestGrantSignature(grantRef:$id){id termsHash}}', { id });
    expect(r.errors).toBeUndefined(); expect(r.data.requestGrantSignature.termsHash).toBe(grantTermsHash(terms));
  });
});
