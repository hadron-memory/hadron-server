import { composeAppSecretUrnV2 } from '@hadron-memory/urn-lib-js';
/** S5 (#4000): the complete, signed secret.use parameter set at grant creation. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from './actions.js';
import { createPendingGrant, GrantCreateRefusal } from './create.js';
import { addAppSecretVersion } from '../secrets/appSecrets.js';
import { dropTestActions, seedWorld, type World } from './grantFixtures3668.js';
let w: World;
let secretId: string;
beforeEach(async () => {
  fault.on = false;
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); w = await seedWorld(); await upsertPlatformActions(db);
  secretId = generateId();
  await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, metadata, updated_at) VALUES (${secretId}, 'app', ${w.appId}, 'api', 'webfetch-auth', '{"type":"bearer","urlPrefix":"https://api.example.test/"}'::jsonb, now())`;
  const payload = JSON.stringify({ type: 'bearer', token: 'synthetic' });
  await db.$transaction((tx) => addAppSecretVersion(tx, { id: secretId, ownerId: w.appId }, payload, Buffer.byteLength(payload), { userId: w.userId, workerId: null, sessionId: null }));
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); await db.$executeRawUnsafe(`DELETE FROM actions WHERE name IN ('secret.reveal', 'secret.use')`); });
const fault = vi.hoisted(() => ({ on: false }));
vi.mock('../secrets/appSecrets.js', async (orig) => {
  const actual = await orig<typeof import('../secrets/appSecrets.js')>();
  const { Prisma: P } = await import('../../generated/prisma/index.js');
  return { ...actual, currentAppSecretValue: (...a: Parameters<typeof actual.currentAppSecretValue>) => {
    if (fault.on) return Promise.reject(new P.PrismaClientInitializationError('db down', 't'));
    return actual.currentAppSecretValue(...a);
  } };
});
const values = () => ({ secret: secretId, 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1', 'binding-header': 'Authorization' });
const grant = (v: unknown) => db.$transaction((tx) => createPendingGrant(tx, {
  appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'app', id: w.appId },
  action: 'secret.use', values: v, reason: 'r', canReadMemory: async () => true,
}));
const refusal = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e instanceof GrantCreateRefusal ? e.code : String(e));
describe('secret.use grant terms (#4000)', () => {
  it('registers the whole action before accepting its typed terms', async () => {
    const action = PLATFORM_ACTIONS.find((a) => a.name === 'secret.use');
    expect(action?.parameters.map((p) => [p.name, p.type])).toEqual([
      ['secret', 'secret-ref'], ['auto-delete', 'secret-mark'], ['binding-prefix', 'https-prefix'], ['binding-header', 'header-name'],
    ]);
    await expect(refusal(grant(values()))).resolves.toBe('OK');
  });
  it('refuses non-HTTPS, embedded credentials, path ambiguity, bad headers, wildcards and lists', async () => {
    for (const [key, value] of [
      ['binding-prefix', 'http://api.example.test/v1'], ['binding-prefix', 'https://u:p@api.example.test/v1'],
      ['binding-prefix', 'https://api.example.test/v1?q=1'], ['binding-prefix', 'https://api.example.test/v1%2fother'],
      ['binding-header', 'X-Bad\r\nInjected'], ['binding-header', '*'], ['binding-header', ['Authorization']],
      ['binding-header', 'Host'], ['binding-header', 'X_Bad'], ['binding-header', 'x'.repeat(65)],
      ['secret', '*'], ['secret', [secretId]],
    ] as const) {
      expect(await refusal(grant({ ...values(), [key]: value }))).toBe('GRANT_VALUES_INVALID');
    }
  });
  it('refuses a binding the use path would refuse: a prefix outside the secret\'s urlPrefix, no urlPrefix, or another auth type (blind P2-1)', async () => {
    expect(await refusal(grant({ ...values(), 'binding-prefix': 'https://other.example.test/v1' }))).toBe('GRANT_VALUES_INVALID');
    await db.$executeRaw`UPDATE secrets SET metadata = '{"type":"bearer"}'::jsonb WHERE id = ${secretId}`;
    expect(await refusal(grant(values()))).toBe('GRANT_VALUES_INVALID');
    await db.$executeRaw`UPDATE secrets SET metadata = '{}'::jsonb WHERE id = ${secretId}`;
    expect(await refusal(grant(values()))).toBe('GRANT_VALUES_INVALID');
    await db.$executeRaw`UPDATE secrets SET metadata = '{"type":"basic","urlPrefix":"https://api.example.test/"}'::jsonb WHERE id = ${secretId}`;
    expect(await refusal(grant(values()))).toBe('GRANT_VALUES_INVALID');
  });
  it('an outage while judging the binding propagates as itself, never as GRANT_VALUES_INVALID (#4775)', async () => {
    fault.on = true;
    const out = await grant(values()).then(() => 'OK', (e: unknown) => e);
    expect(out).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    fault.on = false;
    expect(await refusal(grant({ ...values(), 'binding-prefix': 'https://other.example.test/v1' }))).toBe('GRANT_VALUES_INVALID');
  });
  it('refuses a prefix that ends in a bare ? or # (blind P3-4)', async () => {
    for (const prefix of ['https://api.example.test/v1?', 'https://api.example.test/v1#']) {
      expect(await refusal(grant({ ...values(), 'binding-prefix': prefix }))).toBe('GRANT_VALUES_INVALID');
    }
  });
  it('accepts the delete mark on a secret.use grant when it has a limit, and refuses it without one (cor:sec:060:03)', async () => {
    const marked = { ...values(), 'auto-delete': 'delete' };
    expect(await refusal(grant(marked))).toBe('SECRET_AUTO_DELETE_NEEDS_LIMIT');
    expect(await refusal(db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'app', id: w.appId },
      action: 'secret.use', values: marked, reason: 'r', maxUses: 1, canReadMemory: async () => true,
    })))).toBe('OK');
  });
  it('allows this App as holder, while refusing a different App holder', async () => {
    const appGrant = (id: string) => db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'app', id },
      action: 'secret.use', values: values(), reason: 'r', canReadMemory: async () => true,
    }));
    expect(await refusal(appGrant(w.appId))).toBe('OK');
    expect(await refusal(appGrant(w.app2Id))).toBe('GRANT_HOLDER_NOT_ALLOWED');
  });
  it('creates an App-held request through the manager API and keeps the auto-delete limit rule', async () => {
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'ADMIN' } });
    const ctx: Context = { db, userId: w.userId, roles: [] };
    const input = { appRef: w.appId, holderKind: 'APP' as const, holderRef: w.appId, action: 'secret.use', values: values(), reason: 'r' };
    const result = await resolvers.Mutation.createGrant({}, { input }, ctx);
    const row = await db.grant.findUniqueOrThrow({ where: { id: result.id } });
    expect(row).toMatchObject({ granteeAppId: w.appId, action: 'secret.use', activatedAt: null });
    await expect(resolvers.Mutation.createGrant({}, { input: { ...input, values: { ...values(), 'auto-delete': 'delete' } } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'SECRET_AUTO_DELETE_NEEDS_LIMIT' } });
  });
  it('refuses a worker holder: a use grant nothing could consume is never created', async () => {
    const workerGrant = () => db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'worker', id: w.workerId },
      action: 'secret.use', values: values(), reason: 'r', canReadMemory: async () => true,
    }));
    expect(await refusal(workerGrant())).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.grant.count({ where: { action: 'secret.use', workerId: w.workerId } })).toBe(0);
  });
  it('refuses another App\'s secret with the same refusal as a malformed id', async () => {
    const other = generateId();
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${other}, 'app', ${w.app2Id}, 'api', 'webfetch-auth', now())`;
    expect(await refusal(grant({ ...values(), secret: other }))).toBe('GRANT_VALUES_INVALID');
  });
  it('allows an App holder for secret.use only: any other action with an App holder is refused', async () => {
    const reveal = () => db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'app', id: w.appId },
      action: 'secret.reveal', values: { secret: secretId, 'auto-delete': 'keep' }, reason: 'r', canReadMemory: async () => true,
    }));
    expect(await refusal(reveal())).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.grant.count({ where: { action: 'secret.reveal', granteeAppId: w.appId } })).toBe(0);
  });
  it('does not admit a generic secret as an inject client', async () => {
    const generic = generateId();
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${generic}, 'app', ${w.appId}, 'generic', 'generic', now())`;
    expect(await refusal(grant({ ...values(), secret: generic }))).toBe('GRANT_VALUES_INVALID');
  });
});

describe('secret.use signing summary', () => {
  it('shows both signed binding terms and refuses malformed terms', async () => {
    const { renderGrantSummary } = await import('./summary.js');
    const action = PLATFORM_ACTIONS.find((a) => a.name === 'secret.use')!;
    const input = { action, app: { urn: 'hrn:app:acme.com:ops' },
      values: { secret: 'S1', 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1', 'binding-header': 'Authorization' },
      refs: { S1: { urn: composeAppSecretUrnV2('acme.com', 'ops', 'key') } } };
    expect(renderGrantSummary(input)).toContain('https://api.example.test/v1 with header Authorization');
    expect(() => renderGrantSummary({ ...input, values: { ...input.values, 'binding-header': 'X-Injected\r\nX' } })).toThrow();
  });
});
