/** S2 preparation: public resolver acceptance, independent of S1 key-helper API. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { SECRET_SCOPE_ORDER } from '../../../lib/secrets.js';

let ownerId: string;
let memberId: string;
let appId: string;
const context = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const create = (userId: string, name = 'service-token', value: unknown = 's2-canary') =>
  resolvers.Mutation.createSecret({}, {
    ownerType: 'app', ownerRef: appId, name, kind: 'generic', value,
  }, context(userId));

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s2.test` } })).id;
  memberId = (await db.user.create({ data: { email: `${generateId()}@s2.test` } })).id;
  appId = (await db.app.create({ data: {
    name: 'S2 acceptance', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:secrets`,
  } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
});

describe('App secrets S2 public acceptance', () => {
  it('keeps the run cascade restricted to user and org', () => {
    expect(SECRET_SCOPE_ORDER).toEqual(['user', 'org']);
  });

  it('refuses unknown owner types explicitly', async () => {
    await expect(resolvers.Mutation.createSecret({}, {
      ownerType: 'unregistered', ownerRef: appId, name: 'unknown', kind: 'generic', value: 'control',
    }, context(ownerId))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('allows an App member to store a secret without putting its value in the Secret row', async () => {
    const secret = await create(memberId);
    expect(secret).toMatchObject({ ownerType: 'app', ownerId: appId, name: 'service-token' });
    const row = await db.secret.findUniqueOrThrow({ where: { id: secret.id } });
    expect(row.valueEncrypted).toBeNull();
    expect(JSON.stringify(row)).not.toContain('s2-canary');
  });

  it('lets a creator person delete an unprotected App secret without being its manager', async () => {
    const secret = await create(memberId);
    await expect(resolvers.Mutation.deleteSecret({}, { ref: secret.id }, context(memberId))).resolves.toBe(true);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });

  it('refuses a UTF-8 value over 32 KiB even when its JSON character count fits', async () => {
    // 16,400 code units, but 32,802 serialized UTF-8 bytes (quotes included).
    // Inspect only the refusal code: a failed red control must not dump a ciphertext row.
    const code = await resolvers.Mutation.createSecret({}, {
      ownerType: 'user', name: 'multibyte-overflow', kind: 'generic', value: 'é'.repeat(16_400),
    }, context(ownerId)).then(() => 'ACCEPTED', (error: unknown) =>
      (error as { extensions?: { code?: string } }).extensions?.code);
    expect(code).toBe('BAD_USER_INPUT');
  });
});
