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
import { MAX_OPEN_SECRET_CHANGES } from '../../../lib/secrets/changeRequests.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';

let userId: string, appId: string, secretId: string;
const ctxOf = (extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
const protectAgain = (c: Context, more: Record<string, unknown> = {}) =>
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
    const out = await protectAgain(ctxOf());
    expect(out).toMatchObject({ id: secretId, name: 'canary', kind: 'generic', protected: true, metadata: before.metadata });
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await eventKinds()).toEqual(['STORE']);
    const after = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('repeated past the open-request cap, it never spends a slot', async () => {
    for (let i = 0; i <= MAX_OPEN_SECRET_CHANGES; i += 1) await protectAgain(ctxOf());
    expect(await db.secretChangeRequest.count()).toBe(0);
  });
});

describe('#5299 the silent answer goes only to a caller who passes the staging person checks', () => {
  const refused = async (c: Context) => {
    const e = await error(protectAgain(c));
    expect(e.extensions.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    return e;
  };

  it('a worker session keeps SECRET_PROTECTED_NEEDS_PASSKEY, byte-identical to the refusal for a changing request', async () => {
    const asWorker = <T>(p: () => Promise<T>) => runAsActor({ workerId: generateId(), agentId: null }, p);
    const noop = await asWorker(() => error(protectAgain(ctxOf())));
    const changing = await asWorker(() => error(protectAgain(ctxOf(), { value: 'v2' })));
    expect(noop.extensions.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    expect(noop.message).toBe(changing.message);
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('an App key, an impersonation and a run principal are refused before the guard, exactly as for a changing request', async () => {
    for (const extra of [{ appKeyId: 'k1', appId }, { impersonation: { by: 'x' } }, { clientId: 'run:r1', appId }] as Array<Partial<Context>>) {
      const noop = await error(protectAgain(ctxOf(extra)));
      const changing = await error(protectAgain(ctxOf(extra), { value: 'v2' }));
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

  it('a reader-level member is a person who passes the staging checks: the no-op reaches them, as a changing request is staged for them', async () => {
    const reader = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
    await db.appMember.create({ data: { appId, userId: reader, role: 'reader' } });
    const out = await protectAgain(ctxOf({ userId: reader }));
    expect(out).toMatchObject({ id: secretId, protected: true });
    expect(await db.secretChangeRequest.count()).toBe(0);
    // #5331 item 3 (Jack F3): the same member's changing request is staged, so the no-op and the staging path admit the same callers.
    const e = await error(protectAgain(ctxOf({ userId: reader }), { value: 'v2' }));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect(await db.secretChangeRequest.count()).toBe(1);
  });
});

describe('#5299 what stays as built: anything that DIFFERS still stages', () => {
  it('protected: true with metadata on a protected secret stages a request', async () => {
    const e = await error(protectAgain(ctxOf(), { metadata: { note: 'changed' } }));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect(await db.secretChangeRequest.count()).toBe(1);
  });

  it('protected: true with a value on a protected secret stages a request', async () => {
    const e = await error(protectAgain(ctxOf(), { value: 'v2' }));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect((await db.secretChangeRequest.findFirstOrThrow()).writeVersion).toBe(true);
  });

  it('protected: true on an UNPROTECTED secret still stages (it asks for a real change)', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: false } });
    const e = await error(protectAgain(ctxOf()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect((await db.secretChangeRequest.findFirstOrThrow()).protectedResult).toBe(true);
  });

  it('protected: false on a protected secret still stages the clearing', async () => {
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false }, ctxOf()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
    expect((await db.secretChangeRequest.findFirstOrThrow()).protectedResult).toBe(false);
  });

  it('a non-member stranger gets the member gate\'s refusal, identical to the one for a changing request (the member gate runs first)', async () => {
    const stranger = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
    const noop = await error(protectAgain(ctxOf({ userId: stranger })));
    const changing = await error(protectAgain(ctxOf({ userId: stranger }), { value: 'v2' }));
    expect(noop.extensions.code).toBe('NOT_FOUND');
    expect(noop.extensions).toEqual(changing.extensions);
    expect(noop.message).toBe(changing.message);
    expect(await db.secretChangeRequest.count()).toBe(0);
  });
});

/**
 * #5331 item 6 (Jack F6; spec FIT 7209702827, cor:sec:070:01's Proposed edge): `protected: true` WITH metadata identical to the live row, on
 * a protected secret, asks for no change either. It staged a request whose proof read "Turn protection on" for a flag already on. Same
 * conditions as the bare re-assert: the Secret goes only to a person who passes the staging checks; identical is judged against the live
 * row at the call; any difference stages.
 */
describe('#5331 item 6: protected: true with metadata identical to the live row', () => {
  const live = async () => (await db.secret.findUniqueOrThrow({ where: { id: secretId } })).metadata as Record<string, unknown>;
  beforeEach(async () => { await db.secret.update({ where: { id: secretId }, data: { metadata: { note: 'kept', owner: 'ops' } } }); });

  it('is a no-op for a person who may stage: the row unchanged, no request, no event', async () => {
    const before = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    const out = await protectAgain(ctxOf(), { metadata: { owner: 'ops', note: 'kept' } });
    expect(out).toMatchObject({ id: secretId, protected: true, metadata: before.metadata });
    expect(await db.secretChangeRequest.count()).toBe(0);
    expect(await eventKinds()).toEqual(['STORE']);
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } })).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('repeated past the open-request cap, it never spends a slot', async () => {
    const metadata = await live();
    for (let i = 0; i <= MAX_OPEN_SECRET_CHANGES; i += 1) await protectAgain(ctxOf(), { metadata });
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('any difference still stages: a changed field, an added field, a dropped field, or a value', async () => {
    for (const more of [{ metadata: { note: 'changed', owner: 'ops' } }, { metadata: { note: 'kept', owner: 'ops', extra: 1 } }, { metadata: { note: 'kept' } }, { metadata: { note: 'kept', owner: 'ops' }, value: 'v2' }]) {
      const e = await error(protectAgain(ctxOf(), more));
      expect(e.extensions, JSON.stringify(more)).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
      await db.$executeRaw`DELETE FROM secret_change_requests`;
    }
  });

  it('a worker, an App key, an impersonation and a run keep the refusal they get for a changing request; nothing is staged', async () => {
    const metadata = await live();
    const asWorker = <T>(p: () => Promise<T>) => runAsActor({ workerId: generateId(), agentId: null }, p);
    const noop = await asWorker(() => error(protectAgain(ctxOf(), { metadata })));
    const changing = await asWorker(() => error(protectAgain(ctxOf(), { value: 'v2' })));
    expect(noop.extensions.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    expect(noop.message).toBe(changing.message);
    for (const extra of [{ appKeyId: 'k1', appId }, { impersonation: { by: 'x' } }, { clientId: 'run:r1', appId }] as Array<Partial<Context>>) {
      const n = await error(protectAgain(ctxOf(extra), { metadata }));
      const c = await error(protectAgain(ctxOf(extra), { value: 'v2' }));
      expect(n.extensions, JSON.stringify(extra)).toEqual(c.extensions);
      expect(n.message).toBe(c.message);
    }
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('a non-member stranger gets the same refusal as for a changing request', async () => {
    const stranger = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
    const noop = await error(protectAgain(ctxOf({ userId: stranger }), { metadata: await live() }));
    const changing = await error(protectAgain(ctxOf({ userId: stranger }), { value: 'v2' }));
    expect(noop.extensions).toEqual(changing.extensions);
    expect(noop.message).toBe(changing.message);
  });

  it('on the wire, identical metadata is the no-op whether sent as a variable or as an inline literal (Rook P3-1: a literal is a null-prototype object)', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers: resolvers as never, includeStacktraceInErrorResponses: false });
    const viaVariable = await server.executeOperation({ query: 'mutation($r:ID!,$m:JSON){ updateSecret(ref:$r, protected:true, metadata:$m){ id protected } }', variables: { r: secretId, m: await live() } }, { contextValue: ctxOf() });
    const viaLiteral = await server.executeOperation({ query: 'mutation($r:ID!){ updateSecret(ref:$r, protected:true, metadata:{owner:"ops", note:"kept"}){ id protected } }', variables: { r: secretId } }, { contextValue: ctxOf() });
    for (const res of [viaVariable, viaLiteral]) {
      if (res.body.kind !== 'single') throw new Error('single result expected');
      expect(res.body.singleResult.errors).toBeUndefined();
      expect(res.body.singleResult.data?.updateSecret).toEqual({ id: secretId, protected: true });
    }
    expect(await db.secretChangeRequest.count()).toBe(0);
  });

  it('identical metadata WITHOUT protected: true is outside this item and still stages, as built', async () => {
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, metadata: await live() }, ctxOf()));
    expect(e.extensions).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
  });
});
