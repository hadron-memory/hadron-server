/** #5245; cor:sec:070:02 (Proposed App-wide bound): App cap 100, per-requester App share 20, staging room check. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from '../grants/actions.js';
import * as appKeys from './appKeys.js';

const APP_CAP = 100, SHARE = 20, ROOM = 500;
let appId: string, secretId: string, secret2Id: string;
let manager: Context, member: Context, other: Context, fillers: string[];
const extensions = (p: Promise<unknown>): Promise<Record<string, any>> => p.then(
  () => { throw new Error('expected staged request or refusal'); },
  e => e.extensions,
);
const update = (ctx: Context, ref = secretId) => extensions(resolvers.Mutation.updateSecret({}, { ref, value: 'v' }, ctx));
const create = (ctx: Context, name: string) => extensions(resolvers.Mutation.createSecret({}, {
  ownerType: 'app', ownerRef: appId, name, kind: 'generic', protected: true, value: 'c',
}, ctx));
const staged = (r: Record<string, any>) => expect(r).toMatchObject({ code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) });
const openCount = () => db.secretChangeRequest.count({ where: { appId, state: 'open' } });
/** Direct rows (no ciphertext, no version write): distinct names, spread over `requesters`. */
async function fill(n: number, requesters: string[], opts: { expired?: boolean; prefix?: string; secretless?: boolean } = {}) {
  await db.secretChangeRequest.createMany({ data: Array.from({ length: n }, (_, i) => ({
    id: generateId(), appId, secretId: opts.secretless === false ? secretId : null, secretName: `${opts.prefix ?? 'fill'}-${i}`,
    secretKind: 'generic', operation: 'STORE', requesterId: requesters[i % requesters.length], state: 'open', snapshot: 'absent',
    metadata: {} as never, writeVersion: false, expiresAt: opts.expired ? new Date(0) : new Date(Date.now() + 3_600_000),
  })) });
}
async function fillSecrets(n: number) {
  await db.secret.createMany({ data: Array.from({ length: n }, (_, i) => ({
    id: generateId(), ownerType: 'app', ownerId: appId, name: `bulk-${i}`, kind: 'generic', metadata: {} as never,
  })) });
}

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32));
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  await cleanDb(db);
  await upsertPlatformActions(db);
  const users = await Promise.all(Array.from({ length: 8 }, () => db.user.create({ data: { email: `${generateId()}@app-cap.test` } })));
  [manager, member, other] = users.slice(0, 3).map(u => ({ db, userId: u.id, roles: [] }));
  fillers = users.slice(3).map(u => u.id);
  appId = (await db.app.create({ data: { ownerUserId: manager.userId!, name: 'app cap', urn: `${generateId().toLowerCase()}:appcap` } })).id;
  await db.appMember.createMany({ data: users.slice(1, 3).map(u => ({ appId, userId: u.id, role: 'reader' })) });
  const mk = async (name: string) => {
    const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name, kind: 'generic', value: 'o' }, manager);
    await db.secret.update({ where: { id: s.id }, data: { protected: true } });
    return s.id as string;
  };
  secretId = await mk('bounded'); secret2Id = await mk('bounded-two');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('#5245 App-wide cap', () => {
  it('P1/P2: at the cap every operation is refused for a fresh requester and name, and nothing is staged', async () => {
    await fill(APP_CAP, fillers); // 5 fillers x 20, 100 distinct names
    expect(await openCount()).toBe(APP_CAP);
    const refusals = [
      await update(other),
      await create(other, 'brand-new'),
      await extensions(resolvers.Mutation.deleteSecret({}, { ref: secretId }, manager)),
      await extensions(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: false }, manager)),
    ];
    for (const r of refusals) expect(r).toEqual({ code: 'SECRET_CHANGE_APP_LIMIT' });
    expect(await openCount()).toBe(APP_CAP);
  });

  it('admits at cap minus one, then refuses (control for the count)', async () => {
    await fill(APP_CAP - 1, fillers);
    staged(await update(other));
    expect(await update(other, secret2Id)).toEqual({ code: 'SECRET_CHANGE_APP_LIMIT' });
  });

  it('P3: an expired open row does not count', async () => {
    await fill(APP_CAP - 1, fillers);
    await fill(1, fillers, { expired: true, prefix: 'old' });
    staged(await update(other));
    expect(await openCount()).toBe(APP_CAP + 1); // 99 live + 1 expired-uncleared + the new one
  });

  it('P6: a worker or a surface-off person at the cap still gets the passkey refusal with no requestId', async () => {
    await fill(APP_CAP, fillers);
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    const r = await update(other);
    expect(r.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    expect(r).not.toHaveProperty('requestId');
  });

  it('P7: on the wire the refusal carries only its code', async () => {
    await fill(APP_CAP, fillers);
    const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
    try {
      await api.start();
      const res = await api.executeOperation({ query: 'mutation($ref:ID!){updateSecret(ref:$ref,value:"w"){id}}', variables: { ref: secretId } }, { contextValue: other });
      if (res.body.kind !== 'single') throw new Error('single response required');
      const ext = res.body.singleResult.errors![0].extensions as Record<string, unknown>;
      expect(ext.code).toBe('SECRET_CHANGE_APP_LIMIT');
      for (const k of ['requestId', 'count', 'requester', 'name', 'ceremonyUrl']) expect(ext).not.toHaveProperty(k);
    } finally { await api.stop(); }
  });

  it('P5: concurrent stages of different secrets at cap minus one admit exactly one', async () => {
    await fill(APP_CAP - 1, fillers);
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const original = appKeys.ensureAppKey;
    let first = true;
    const spy = vi.spyOn(appKeys, 'ensureAppKey').mockImplementation(async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return original(...args);
    });
    let a: Promise<Record<string, any>> | undefined, b: Promise<Record<string, any>> | undefined;
    try {
      a = update(member, secretId);
      await paused;
      b = update(other, secret2Id);
      let waited = false;
      for (let i = 0; i < 200; i++) {
        const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted
          AND l.classid::bigint=(hashtext('hadron:secret-change-app')::bigint & 4294967295)
          AND l.objid::bigint=(hashtext(${appId})::bigint & 4294967295) AND l.objsubid=2`;
        if (Number(n) > 0) { waited = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(waited, 'the second stage waits on the App-wide lock before counting').toBe(true);
      release();
      staged(await a);
      expect(await b).toEqual({ code: 'SECRET_CHANGE_APP_LIMIT' });
      expect(await openCount()).toBe(APP_CAP);
    } finally {
      release();
      await Promise.allSettled([a, b].filter(Boolean) as Promise<unknown>[]);
      spy.mockRestore();
    }
  }, 20_000);
});

describe('#5245 R2 per-requester App share', () => {
  it('P8: a requester at the share is refused under a new name; another is admitted; expired rows do not count', async () => {
    await fill(SHARE - 1, [member.userId!]);
    await fill(1, [member.userId!], { expired: true, prefix: 'old' });
    staged(await create(member, 'share-ok')); // 19 live + 1 expired: admitted, now 20 live
    expect(await create(member, 'share-over')).toEqual({ code: 'SECRET_CHANGE_REQUESTER_LIMIT' });
    staged(await create(other, 'share-other'));
    expect(await db.secretChangeRequest.count({ where: { appId, requesterId: member.userId!, state: 'open' } })).toBe(SHARE + 1);
  });
});

describe('#5245 staging room check', () => {
  it('P4: a protected create in an App at its secret limit is refused like an unprotected one; nothing staged', async () => {
    await fillSecrets(ROOM - 2); // bounded + bounded-two + bulk = ROOM
    const unprotected = await extensions(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'plain', kind: 'generic', value: 'x' }, manager));
    expect(unprotected.code).toBe('SECRET_LIMIT_REACHED');
    expect(await create(manager, 'one-more')).toEqual(unprotected);
    expect(await db.secretChangeRequest.count({ where: { appId } })).toBe(0);
  });

  it('P9: an open protected create counts toward the room; expiry frees it; completion is judged without it', async () => {
    await fillSecrets(ROOM - 3); // one slot left
    const first = await create(manager, 'slot-one');
    staged(first);
    expect(await create(member, 'slot-two')).toMatchObject({ code: 'SECRET_LIMIT_REACHED' });
    expect(await db.secretChangeRequest.count({ where: { appId } })).toBe(1);
    await db.secretChangeRequest.update({ where: { id: first.requestId }, data: { expiresAt: new Date(0) } });
    staged(await create(member, 'slot-two'));
  });

  it('P10: concurrent protected creates at the edge of the room admit exactly one', async () => {
    await fillSecrets(ROOM - 3);
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const original = appKeys.ensureAppKey;
    let first = true;
    const spy = vi.spyOn(appKeys, 'ensureAppKey').mockImplementation(async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return original(...args);
    });
    let a: Promise<Record<string, any>> | undefined, b: Promise<Record<string, any>> | undefined;
    try {
      a = create(member, 'edge-a');
      await paused;
      b = create(other, 'edge-b');
      await new Promise(r => setTimeout(r, 300));
      release();
      staged(await a);
      expect(await b).toMatchObject({ code: 'SECRET_LIMIT_REACHED' });
      expect(await db.secretChangeRequest.count({ where: { appId, state: 'open' } })).toBe(1);
    } finally {
      release();
      await Promise.allSettled([a, b].filter(Boolean) as Promise<unknown>[]);
      spy.mockRestore();
    }
  }, 20_000);
});
