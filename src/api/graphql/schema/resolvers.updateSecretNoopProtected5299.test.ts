/**
 * #5299 (mirror of #4749 for the other direction): `updateSecret(protected: true)` on an App secret that is ALREADY protected, with no
 * value and no metadata, asks for no change. It staged a STORE request (a spent open-request slot and a ceremony) whose completion is an
 * idempotent no-op. cor:sec:070:01 (who changes a protected secret), :02 (a request exists for a CHANGE), cor:sec:010:05 (a no-op is not
 * recorded). Spec FIT (Victor, AT0.10980.1): COMPLIANT on one condition: unlike #4749 no gate runs before the transaction, so the silent
 * no-op goes ONLY to a caller who would pass stageSecretChange's person checks; everyone else keeps SECRET_PROTECTED_NEEDS_PASSKEY.
 * The silent answer relies on 070:01's PROPOSED edge case, so these pins say "built as", not law.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';

let userId: string, appId: string, secretId: string;
const ctxOf = (extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
const reassert = (c: Context, more: Record<string, unknown> = {}) =>
  resolvers.Mutation.updateSecret({}, { ref: secretId, protected: true, ...more }, c);
const eventKinds = async () =>
  (await db.secretEvent.findMany({ where: { ownerId: appId, secretName: 'canary' }, orderBy: [{ at: 'asc' }, { seq: 'asc' }], select: { kind: true } })).map((e) => e.kind);

afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S5 noop', urn: `${generateId().toLowerCase()}:s5n` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctxOf())).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
});

describe('#5299 protected: true alone on an already-protected secret, for a person who may stage a change', () => {
  it('is a silent no-op: the row comes back unchanged, no request, no slot spent, no event', async () => {
    const before = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    const out = await reassert(ctxOf());
    expect(out).toMatchObject({ id: secretId, name: 'canary', kind: 'generic', protected: true, metadata: before.metadata });
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await eventKinds()).toEqual(['STORE']);
    const after = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('repeated, it never spends a slot (the open-request cap is not reached)', async () => {
    for (let i = 0; i < 12; i += 1) await reassert(ctxOf());
    expect(await db.secretChangeRequest.count()).toBe(0);
  });
});

describe('#5299 the silent answer goes only to a caller who passes the staging person checks', () => {
  const refused = async (c: Context) => {
    const e = await error(reassert(c));
    expect(e.extensions.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    return e;
  };

  it('a worker session keeps SECRET_PROTECTED_NEEDS_PASSKEY, byte-identical to the refusal for a changing request', async () => {
    const asWorker = <T>(p: () => Promise<T>) => runAsActor({ workerId: generateId(), agentId: null }, p);
    const noop = await asWorker(() => error(reassert(ctxOf())));
    const changing = await asWorker(() => error(reassert(ctxOf(), { value: 'v2' })));
    expect(noop.extensions.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    expect(noop.message).toBe(changing.message);
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('an App key, an impersonation and a run principal are refused before the guard, exactly as for a changing request', async () => {
    for (const extra of [{ appKeyId: 'k1', appId }, { impersonation: { by: 'x' } }, { clientId: 'run:r1', appId }] as Array<Partial<Context>>) {
      const noop = await error(reassert(ctxOf(extra)));
      const changing = await error(reassert(ctxOf(extra), { value: 'v2' }));
      expect(noop.extensions, JSON.stringify(extra)).toEqual(changing.extensions);
      expect(noop.message).toBe(changing.message);
      expect(noop.extensions.code).not.toBeUndefined();
    }
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('with the signing surface off every caller keeps it, a person included', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    await refused(ctxOf());
  });

  it('a member who may not change the secret at all still gets the same refusal as before', async () => {
    const reader = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
    await db.appMember.create({ data: { appId, userId: reader, role: 'reader' } });
    // a reader is a person and passes the staging checks, so a no-op reaches them like any member (same as a changing request would be staged)
    const out = await reassert(ctxOf({ userId: reader }));
    expect(out).toMatchObject({ id: secretId, protected: true });
    expect(await db.secretChangeRequest.count()).toBe(0);
  });
});

describe('#5299 what stays as built: anything that DIFFERS still stages', () => {
  it('protected: true with metadata on a protected secret stages a request', async () => {
    const e = await error(reassert(ctxOf(), { metadata: { note: 'changed' } }));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect(await db.secretChangeRequest.count()).toBe(1);
  });

  it('protected: true with a value on a protected secret stages a request', async () => {
    const e = await error(reassert(ctxOf(), { value: 'v2' }));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect((await db.secretChangeRequest.findFirstOrThrow()).writeVersion).toBe(true);
  });

  it('protected: true on an UNPROTECTED secret still stages (it asks for a real change)', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: false } });
    const e = await error(reassert(ctxOf()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect((await db.secretChangeRequest.findFirstOrThrow()).protectedResult).toBe(true);
  });

  it('protected: false on a protected secret still stages the clearing', async () => {
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false }, ctxOf()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect((await db.secretChangeRequest.findFirstOrThrow()).protectedResult).toBe(false);
  });

  it('a non-member stranger is refused as before (the member gate runs first)', async () => {
    const stranger = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
    const e = await error(reassert(ctxOf({ userId: stranger })));
    expect(e.extensions.code).not.toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
  });
});
