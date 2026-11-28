/** cor:sec:070:02; Bill130883: two per requester inside five per secret, under one name lock. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from '../grants/actions.js';
import * as appKeys from './appKeys.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';

let appId: string, secretId: string;
let manager: Context, member: Context, other: Context, fourth: Context;
const extensions = (p: Promise<unknown>): Promise<Record<string, any>> => p.then(
  () => { throw new Error('expected staged request or refusal'); },
  e => e.extensions,
);
const store = (ctx: Context, ref = secretId) => extensions(
  resolvers.Mutation.updateSecret({}, { ref, value: 'requester-cap-canary' }, ctx),
);
const create = (ctx: Context, name: string) => extensions(resolvers.Mutation.createSecret({}, {
  ownerType: 'app', ownerRef: appId, name, kind: 'generic', protected: true, value: 'create-cap-canary',
}, ctx));
const staged = (result: Record<string, any>) => expect(result).toMatchObject({
  code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String),
});

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32));
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  await cleanDb(db);
  await upsertPlatformActions(db);
  const users = await Promise.all(Array.from({ length: 4 }, () => db.user.create({
    data: { email: `${generateId()}@requester-cap.test` },
  })));
  [manager, member, other, fourth] = users.map(user => ({ db, userId: user.id, roles: [] }));
  appId = (await db.app.create({ data: {
    ownerUserId: manager.userId!, name: 'requester cap', urn: `${generateId().toLowerCase()}:cap`,
  } })).id;
  await db.appMember.createMany({ data: users.slice(1).map(user => ({ appId, userId: user.id, role: 'reader' })) });
  secretId = (await resolvers.Mutation.createSecret({}, {
    ownerType: 'app', ownerRef: appId, name: 'bounded', kind: 'generic', value: 'original',
  }, manager)).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('#3999 requester budgets', () => {
  it('refuses a member third request without blocking a manager DELETE', async () => {
    staged(await store(member));
    staged(await store(member));
    expect(await store(member)).toEqual({ code: 'SECRET_CHANGE_REQUESTER_LIMIT' });
    staged(await extensions(resolvers.Mutation.deleteSecret({}, { ref: secretId }, manager)));
    expect(await db.secretChangeRequest.count({ where: { appId, requesterId: member.userId!, state: 'open' } })).toBe(2);
    expect(await db.secretChangeRequest.count({ where: { appId, requesterId: manager.userId!, operation: 'DELETE' } })).toBe(1);
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('retains the aggregate five limit across different requesters', async () => {
    for (const ctx of [member, member, manager, manager, other]) staged(await store(ctx));
    expect(await store(other)).toEqual({ code: 'SECRET_CHANGE_REQUEST_LIMIT' });
    expect(await db.secretChangeRequest.count({ where: { appId, state: 'open' } })).toBe(5);
  });

  it('returns the requester limit over GraphQL without a staged request id', async () => {
    staged(await store(member));
    staged(await store(member));
    const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
    try {
      await api.start();
      const result = await api.executeOperation({
        query: 'mutation($ref:ID!){updateSecret(ref:$ref,value:"wire-canary"){id}}',
        variables: { ref: secretId },
      }, { contextValue: member });
      expect(result.body.kind).toBe('single');
      if (result.body.kind !== 'single') throw new Error('single response required');
      expect(result.body.singleResult.errors).toHaveLength(1);
      expect(result.body.singleResult.errors![0].extensions).toMatchObject({ code: 'SECRET_CHANGE_REQUESTER_LIMIT' });
      expect(result.body.singleResult.errors![0].extensions).not.toHaveProperty('requestId');
      expect(await db.secretChangeRequest.count({ where: { appId } })).toBe(2);
    } finally {
      await api.stop();
    }
  });

  it('does not count withdrawn or already expired requests against either limit', async () => {
    const first = await store(member);
    staged(first);
    const saved = await db.secretChangeRequest.findUniqueOrThrow({ where: { id: first.requestId } });
    await resolvers.Mutation.withdrawSecretChangeRequest({}, { id: first.requestId }, member);
    await db.secretChangeRequest.create({ data: {
      id: generateId(), appId, secretId, secretName: saved.secretName, secretKind: saved.secretKind,
      operation: saved.operation, requesterId: member.userId!, state: 'open', snapshot: saved.snapshot,
      metadata: saved.metadata as never, expiresAt: new Date(0), writeVersion: false,
    } });
    staged(await store(member));
    staged(await store(member));
    expect(await store(member)).toEqual({ code: 'SECRET_CHANGE_REQUESTER_LIMIT' });
    expect(await db.secretChangeRequest.count({ where: { appId } })).toBe(4);
  });

  it('scopes the requester budget to the App and secret name', async () => {
    staged(await store(member));
    staged(await store(member));
    staged(await create(member, 'another-name'));
    const secondApp = await db.app.create({ data: {
      ownerUserId: manager.userId!, name: 'other App', urn: `${generateId().toLowerCase()}:other-cap`,
    } });
    await db.appMember.create({ data: { appId: secondApp.id, userId: member.userId!, role: 'reader' } });
    staged(await extensions(resolvers.Mutation.createSecret({}, {
      ownerType: 'app', ownerRef: secondApp.id, name: 'bounded', kind: 'generic', protected: true, value: 'other App',
    }, member)));
  });

  it('refuses redundant protection-on requests without staging or spending the budget', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await extensions(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: true }, member)))
        .toMatchObject({ code: 'BAD_USER_INPUT' });
    }
    expect(await db.secretChangeRequest.count({ where: { appId } })).toBe(0);
    staged(await store(member));
    staged(await store(member));
    expect(await store(member)).toEqual({ code: 'SECRET_CHANGE_REQUESTER_LIMIT' });
  });

  it.each(['requester', 'aggregate'] as const)('serializes the %s boundary for a protected create with no secret row', async limit => {
    const name = 'uncreated';
    for (const ctx of limit === 'requester' ? [member] : [member, member, manager, manager]) {
      staged(await create(ctx, name));
    }
    expect(await db.secret.count({ where: { ownerId: appId, name } })).toBe(0);
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = appKeys.ensureAppKey;
    let first = true;
    const spy = vi.spyOn(appKeys, 'ensureAppKey').mockImplementation(async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return original(...args);
    });
    let a: Promise<Record<string, any>> | undefined, b: Promise<Record<string, any>> | undefined;
    try {
      a = create(limit === 'requester' ? member : other, name);
      await paused;
      b = create(limit === 'requester' ? member : fourth, name);
      let waited = false;
      for (let i = 0; i < 200; i++) {
        const lockKey = `hadron:secret-change:${appId}:${name}`;
        const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted
          AND l.classid::bigint=((hashtext(${lockKey})::bigint >> 32) & 4294967295)
          AND l.objid::bigint=(hashtext(${lockKey})::bigint & 4294967295) AND l.objsubid=1`;
        if (Number(n) > 0) { waited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waited, 'the second create waits on the shared name lock before counting').toBe(true);
      release();
      staged(await a);
      expect(await b).toEqual({ code: limit === 'requester' ? 'SECRET_CHANGE_REQUESTER_LIMIT' : 'SECRET_CHANGE_REQUEST_LIMIT' });
      expect(await db.secretChangeRequest.count({ where: { appId, secretName: name, state: 'open' } }))
        .toBe(limit === 'requester' ? 2 : 5);
    } finally {
      release();
      await Promise.allSettled([a, b].filter(Boolean) as Promise<unknown>[]);
      spy.mockRestore();
    }
  }, 20_000);
});
