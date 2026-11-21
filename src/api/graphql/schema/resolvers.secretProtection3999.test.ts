/** #3999: protected writes stage only a person's request; no value is written before the ceremony. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let userId: string, appId: string, secretId: string;
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const refusal = async (p: Promise<unknown>) => p.then(() => ({ code: 'ACCEPTED' }), (e) => e.extensions);
beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  process.env.PASSKEY_SIGNING_ENABLED = 'true';
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4', urn: `${generateId().toLowerCase()}:s4` } })).id;
  const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx());
  secretId = s.id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
});
describe('#3999 protected change admission', () => {
  it('stages a person store and returns a request id and server ceremony link without writing a version', async () => {
    const result = await refusal(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 's4-staged-canary' }, ctx()));
    expect(result).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String), ceremonyUrl: expect.stringContaining('/secret-changes/') });
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
    expect(JSON.stringify(result)).not.toContain('s4-staged-canary');
  });
  it('requires the same ceremony for an owner deleting a protected secret', async () => {
    expect(await refusal(resolvers.Mutation.deleteSecret({}, { ref: secretId }, ctx()))).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect(await db.secret.count({ where: { id: secretId } })).toBe(1);
  });
  it('refuses protected writes while signing is off without creating a version', async () => {
    process.env.PASSKEY_SIGNING_ENABLED = 'false';
    expect(await refusal(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 's4-off-canary' }, ctx()))).toEqual({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY' });
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });
});
