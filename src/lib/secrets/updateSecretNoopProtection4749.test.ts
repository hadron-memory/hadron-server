/**
 * #4749 (the defect class of #4717 item 8, reached through updateSecret): `updateSecret(protected: false)` on an App secret that is NOT
 * protected asked for no protection change, yet it staged a STORE change request, spent one of the secret's open-request slots and sent
 * the caller through a passkey ceremony for a change that does nothing. cor:sec:070:01 (who turns protection off), :02 (a protected
 * secret's changes go through a person's request), cor:sec:010:05 (a change is recorded; a no-op is not one).
 *
 * Spec FIT (AT0.9589.1): the normalisation sits AFTER the pre-transaction manager gate (a non-manager sees the same refusal either way);
 * `protected: false` alone is a SILENT NO-OP (the secret returned unchanged, no event); the one METADATA event follows BUILT behaviour
 * (010:05's Built line, Proposed), so the descriptions say "built as", not law. The mirror case (`protected: true` on a protected secret)
 * stays as built.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../grants/actions.js';

let userId: string, appId: string, secretId: string;
const ctx = (as: string = userId): Context => ({ db, userId: as, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
const eventKinds = async () =>
  (await db.secretEvent.findMany({ where: { ownerId: appId, secretName: 'canary' }, orderBy: { at: 'asc' }, select: { kind: true } })).map((e) => e.kind);
const member = async () => {
  const id = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  await db.appMember.create({ data: { appId, userId: id, role: 'reader' } });
  return id;
};

afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 noop', urn: `${generateId().toLowerCase()}:s4n` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
});

describe('#4749 updateSecret(protected: false) on an UNPROTECTED secret asks for no protection change', () => {
  it('with metadata: an ordinary update, no request staged, no slot spent, one METADATA event (built as)', async () => {
    const out = await resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false, metadata: { note: 'renamed' } }, ctx());
    expect(out).toMatchObject({ id: secretId, protected: false });
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } })).metadata).toEqual({ note: 'renamed' });
    expect(await eventKinds()).toEqual(['STORE', 'METADATA']);
  });

  it('with a value: an ordinary new version, no request staged', async () => {
    await resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false, value: 'second' }, ctx());
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(2);
    expect(await eventKinds()).toEqual(['STORE', 'VERSION']);
  });

  it('alone: a silent no-op, nothing staged, no event, the secret returned unchanged', async () => {
    const before = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    const out = await resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false }, ctx());
    expect(out).toMatchObject({ id: secretId, name: 'canary', kind: 'generic', protected: false, metadata: before.metadata });
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await eventKinds()).toEqual(['STORE']);
    const after = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('a member who cannot turn protection off gets the same refusal whether or not the secret is protected', async () => {
    const reader = ctx(await member());
    const unprotected = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false, metadata: { note: 'x' } }, reader));
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const protectedOne = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false, metadata: { note: 'x' } }, reader));
    expect(unprotected.extensions).toEqual(protectedOne.extensions);
    expect(unprotected.message).toBe(protectedOne.message);
    expect(unprotected.extensions.code).toBe('FORBIDDEN');
    expect(await db.secretChangeRequest.count()).toBe(0);
  });
});

describe('#4749 an explicit GraphQL null asks for no protection change, like an omitted argument', () => {
  it('protected: null alone on an unprotected or a protected secret is refused as an empty update, nothing staged', async () => {
    for (const isProtected of [false, true]) {
      await db.secret.update({ where: { id: secretId }, data: { protected: isProtected } });
      const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: null as never }, ctx()));
      expect(e.extensions.code, `protected=${isProtected}`).toBe('BAD_USER_INPUT');
    }
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('protected: null with metadata on an unprotected secret is an ordinary update, nothing staged', async () => {
    await resolvers.Mutation.updateSecret({}, { ref: secretId, protected: null as never, metadata: { note: 'n' } }, ctx());
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await eventKinds()).toEqual(['STORE', 'METADATA']);
  });

  it('protected: null with a value on a PROTECTED secret still stages (a protected secret changes only through the ceremony)', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: null as never, value: 'v2' }, ctx()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
  });
});

describe('#4749 what stays as built', () => {
  it('protected: false on a PROTECTED secret still stages the change (that clears protection, which needs the ceremony)', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false }, ctx()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect(await db.secretChangeRequest.count()).toBe(1);
    // and it still carries the change it asks for: clearing protection (a request that dropped it would clear nothing)
    expect((await db.secretChangeRequest.findFirstOrThrow()).protectedResult).toBe(false);
  });

  it('protected: true on an unprotected secret still stages (it asks for a real change)', async () => {
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: true }, ctx()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect(await db.secretChangeRequest.count()).toBe(1);
    expect((await db.secretChangeRequest.findFirstOrThrow()).protectedResult).toBe(true);
  });

  it('an update with no protected flag on an unprotected secret is ordinary, as before', async () => {
    await resolvers.Mutation.updateSecret({}, { ref: secretId, metadata: { note: 'plain' } }, ctx());
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await eventKinds()).toEqual(['STORE', 'METADATA']);
  });
});
