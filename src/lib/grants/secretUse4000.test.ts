/** S5 (#4000): the complete, signed secret.use parameter set at grant creation. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from './actions.js';
import { createPendingGrant, GrantCreateRefusal } from './create.js';
import { dropTestActions, seedWorld, type World } from './grantFixtures3668.js';
let w: World;
let secretId: string;
beforeEach(async () => {
  await cleanDb(db); w = await seedWorld(); await upsertPlatformActions(db);
  secretId = generateId();
  await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${secretId}, 'app', ${w.appId}, 'api', 'webfetch-auth', now())`;
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); await db.$executeRawUnsafe(`DELETE FROM actions WHERE name IN ('secret.reveal', 'secret.use')`); });
const values = () => ({ secret: secretId, 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1', 'binding-header': 'Authorization' });
const grant = (v: unknown) => db.$transaction((tx) => createPendingGrant(tx, {
  appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'worker', id: w.workerId },
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
      ['secret', '*'], ['secret', [secretId]],
    ] as const) {
      expect(await refusal(grant({ ...values(), [key]: value }))).toBe('GRANT_VALUES_INVALID');
    }
  });
  it('does not admit a generic secret as an inject client', async () => {
    const generic = generateId();
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${generic}, 'app', ${w.appId}, 'generic', 'generic', now())`;
    expect(await refusal(grant({ ...values(), secret: generic }))).toBe('GRANT_VALUES_INVALID');
  });
});
