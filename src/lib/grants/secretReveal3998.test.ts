/**
 * #3998 S3 / cor:acl:140:09 (secret forms, byte review checkpoint 1): the seeded `secret.reveal` action and the admission rules of its
 * two value types, judged through the one grant writer. Terms bytes are pinned against the reviewer's vectors.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from './actions.js';
import { createPendingGrant, GrantCreateRefusal } from './create.js';
import { grantTermsBytes } from './terms.js';
import { dropTestActions, seedWorld, type World } from './grantFixtures3668.js';

let w: World;
let secretId: string;
beforeEach(async () => {
  await cleanDb(db); w = await seedWorld(); await upsertPlatformActions(db);
  secretId = generateId();
  await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${secretId}, 'app', ${w.appId}, 'tok', 'generic', now())`;
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); await db.$executeRawUnsafe(`DELETE FROM actions WHERE name = 'secret.reveal'`); });

const grant = (values: unknown, appId = w.appId) => db.$transaction((tx) => createPendingGrant(tx, {
  appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'worker', id: w.workerId },
  action: 'secret.reveal', values, reason: 'r', canReadMemory: async () => true,
}));
const refusal = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof GrantCreateRefusal ? `${e.code}` : String(e)));

describe('#3998 secret.reveal', () => {
  it('is seeded once with its full parameter list and the closed issuer key', () => {
    const a = PLATFORM_ACTIONS.find((x) => x.name === 'secret.reveal')!;
    expect(a).toMatchObject({ source: 'PLATFORM', tool: null, enforcement: 'SERVER', issuerRule: 'SECRET_READ_CLIENT' });
    expect(a.parameters).toEqual([
      { name: 'secret', type: 'secret-ref', refusesWildcard: true },
      { name: 'auto-delete', type: 'secret-mark', refusesWildcard: true },
    ]);
    expect(PLATFORM_ACTIONS.find((x) => x.name === 'secret.use')).toBeUndefined();
  });

  it('admits the secret id and a keep or delete mark, and stores the signed bytes the reviewer fixed', async () => {
    await expect(refusal(grant({ secret: secretId, 'auto-delete': 'keep' }))).resolves.toBe('OK');
    await expect(refusal(grant({ secret: secretId, 'auto-delete': 'delete' }))).resolves.toBe('OK');
    const bytes = grantTermsBytes({ appId: w.appId, holder: { kind: 'worker', id: w.workerId }, action: 'secret.reveal',
      values: { secret: 'cm3k9x2b00002ab12cd34ef57', 'auto-delete': 'keep' }, startsAt: null, expiresAt: null, maxUses: null, reason: 'r' });
    expect(Buffer.from(bytes as never).toString('utf8')).toContain('{"auto-delete":"keep","secret":"cm3k9x2b00002ab12cd34ef57"}');
  });

  it.each([
    ['a wildcard secret', { secret: '*', 'auto-delete': 'keep' }],
    ['a list of secrets', { secret: ['aaaaaaaa', 'bbbbbbbb'], 'auto-delete': 'keep' }],
    ['a boolean mark', { secret: 'S', 'auto-delete': true }],
    ['a wrong-case mark', { secret: 'S', 'auto-delete': 'Keep' }],
    ['a list mark', { secret: 'S', 'auto-delete': ['keep'] }],
    ['a wildcard mark', { secret: 'S', 'auto-delete': '*' }],
    ['a secret name instead of an id', { secret: 'tok', 'auto-delete': 'keep' }],
    ['a URN', { secret: 'hrn:secret:x:tok', 'auto-delete': 'keep' }],
    ['a missing mark', { secret: 'S' }],
    ['an extra key', { secret: 'S', 'auto-delete': 'keep', extra: 'x' }],
  ])('refuses %s', async (_n, values) => {
    const v = JSON.parse(JSON.stringify(values).replace('"S"', JSON.stringify(secretId)));
    expect(await refusal(grant(v))).toBe('GRANT_VALUES_INVALID');
  });

  it('refuses a secret that is missing, of another App, an org secret, or an inject-only kind, all the same way', async () => {
    const other = generateId(); const org = generateId(); const inject = generateId();
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${other}, 'app', ${w.app2Id}, 'tok', 'generic', now())`;
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, value_encrypted, updated_at) VALUES (${org}, 'org', ${w.orgId}, 'o', 'generic', 'x', now())`;
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${inject}, 'app', ${w.appId}, 'inj', 'webfetch-auth', now())`;
    for (const id of ['doesnotexist1', other, org, inject]) {
      expect(await refusal(grant({ secret: id, 'auto-delete': 'keep' }))).toBe('GRANT_VALUES_INVALID');
    }
  });

  it('admits a live person holder for secret.reveal only, and refuses a gone person or another action', async () => {
    const person = (id: string, action = 'secret.reveal') => db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'user', id },
      action, values: { secret: secretId, 'auto-delete': 'keep' }, reason: 'r', canReadMemory: async () => true,
    }));
    const id = await person(w.userId);
    const row = await db.$queryRaw<Array<{ user_id: string; agent_id: string | null; worker_id: string | null }>>`SELECT user_id, agent_id, worker_id FROM grants WHERE id = ${id}`;
    expect(row[0]).toEqual({ user_id: w.userId, agent_id: null, worker_id: null });
    expect(await refusal(person(generateId()))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await refusal(person(w.userId, 'secret.delete'))).toBe('GRANT_HOLDER_NOT_ALLOWED');
  });
});

import { renderGrantSummary } from './summary.js';
import { composeAppSecretUrnV2 } from '@hadron-memory/urn-lib-js';
describe('#3998 secret.reveal summary line', () => {
  const action = PLATFORM_ACTIONS.find((x) => x.name === 'secret.reveal')!;
  const app = { urn: 'hrn:app:acme.com:ops' };
  const urn = composeAppSecretUrnV2('acme.com', 'ops', 'stripe-key');
  it('writes the App secret as its canonical URN', () => {
    expect(renderGrantSummary({ action, app, values: { secret: 'S1', 'auto-delete': 'keep' }, refs: { S1: { urn } } }))
      .toBe(`Read the value of the secret ${urn} of hrn:app:acme.com:ops`);
  });
  it.each(['hrn:secret:acme.com:stripe-key', 'stripe-key', `${urn}#data`, `${urn} x`])('refuses %s', (bad) => {
    expect(() => renderGrantSummary({ action, app, values: { secret: 'S1', 'auto-delete': 'keep' }, refs: { S1: { urn: bad } } })).toThrow();
  });
});
