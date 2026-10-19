/** #1744 / cor:dmo:050:05: one manager audience for credential issuance and inventory. */
import { beforeEach, describe, expect, it } from 'vitest';
import { runAsActor } from '../../../lib/requestActor.js';
import type { Role } from '../../../generated/prisma/index.js';
import { parse, type OperationDefinitionNode } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { impersonationReadOnlyPlugin } from '../impersonationReadOnlyPlugin.js';
import { resolvers, type Context } from './resolvers.js';
import { typeResolvers } from './resolvers.types.js';

const M = resolvers.Mutation;
const Q = resolvers.Query;
const writes = ['mint', 'revoke', 'rotate'] as const;
let orgId: string;
let appId: string;
let personalAppId: string;
let users: Record<string, string>;
const ctx = (name: string, extra: Partial<Context> = {}): Context => ({ db, userId: users[name], roles: ['READER'], ...extra });
const snapshot = () => db.appKey.findMany({ where: { appId: { in: [appId, personalAppId] } }, orderBy: { id: 'asc' } });
async function seedKey(target = appId) {
  return db.appKey.create({ data: { appId: target, keyHash: generateId(), keyPreview: 'test' } });
}
async function write(op: typeof writes[number], context: Context, target = appId) {
  if (op === 'rotate') return M.regenerateAppKey({}, { appRef: target }, context);
  if (op === 'mint') return M.createAppKey({}, { appRef: target, label: 'manager pin' }, context);
  const key = await db.appKey.findFirstOrThrow({ where: { appId: target, revokedAt: null } });
  return M.revokeAppKey({}, { id: key.id }, context);
}
async function forbidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
}

beforeEach(async () => {
  await cleanDb(db);
  users = {};
  for (const name of ['owner', 'member', 'reader', 'contributor', 'orgReader', 'admin', 'orgOwner', 'revoked', 'foreign', 'platformAdmin', 'platformOwner', 'userOwner']) {
    const roles: Role[] = name === 'platformAdmin' ? ['ADMIN'] : name === 'platformOwner' ? ['OWNER'] : ['READER'];
    users[name] = (await db.user.create({ data: { id: generateId(), handle: `key-${generateId()}`, roles } })).id;
  }
  const org = await db.organization.create({ data: { urn: `keys-${generateId()}`, name: 'Keys' } });
  orgId = org.id;
  const other = await db.organization.create({ data: { urn: `other-${generateId()}`, name: 'Other' } });
  for (const [name, role] of Object.entries({ owner: 'READER', member: 'READER', reader: 'READER', contributor: 'CONTRIBUTOR', orgReader: 'READER', admin: 'ADMIN', orgOwner: 'OWNER', revoked: 'ADMIN' })) {
    await db.orgMember.create({ data: { organizationId: orgId, userId: users[name]!, role: role as 'READER', deletedAt: name === 'revoked' ? new Date() : null } });
  }
  await db.orgMember.create({ data: { organizationId: other.id, userId: users.foreign!, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { urn: `${org.urn}:keys`, name: 'Keys', organizationId: orgId } })).id;
  personalAppId = (await db.app.create({ data: { urn: `personal-${generateId()}:keys`, name: 'Personal keys', ownerUserId: users.userOwner! } })).id;
  for (const target of [appId, personalAppId]) {
    for (const [name, role] of Object.entries({ owner: 'owner', member: 'member', reader: 'reader' })) {
      await db.appMember.create({ data: { appId: target, userId: users[name]!, role } });
    }
    await seedKey(target);
  }
});

describe('#1744 mint/revoke/rotate audience', () => {
  for (const op of writes) {
    for (const personal of [false, true]) {
      it(`${op}: owner-role member of a ${personal ? 'user' : 'org'}-owned App is a manager`, async () => {
        const target = personal ? personalAppId : appId;
        const result = await write(op, ctx('owner'), target);
        if (op !== 'revoke') expect(result).toHaveProperty('rawKey');
        else expect(result).toBe(true);
      });
    }
    for (const name of ['admin', 'orgOwner', 'platformAdmin', 'platformOwner', 'userOwner']) {
      it(`${op}: existing ${name} manager remains admitted`, async () => {
        const target = name === 'userOwner' ? personalAppId : appId;
        const roles: Role[] = name === 'platformAdmin' ? ['ADMIN'] : name === 'platformOwner' ? ['OWNER'] : ['READER'];
        await expect(write(op, ctx(name, { roles }), target)).resolves.toBeTruthy();
      });
    }
    for (const name of ['member', 'reader', 'contributor', 'orgReader', 'foreign', 'revoked']) {
      it(`${op}: ${name} cannot change credentials`, async () => {
        const before = await snapshot();
        await forbidden(write(op, ctx(name)));
        expect(await snapshot()).toEqual(before);
      });
    }
    for (const session of [undefined, generateId()]) {
      it(`${op}: own App key ${session ? 'with' : 'without'} session is not a manager`, async () => {
        const before = await snapshot();
        await forbidden(write(op, { db, appId, roles: [], ...(session ? { sessionId: session } : {}) } as Context));
        expect(await snapshot()).toEqual(before);
      });
    }
    it(`${op}: direct resolver refuses an impersonated org ADMIN`, async () => {
      const before = await snapshot();
      await forbidden(write(op, ctx('admin', { impersonation: { sessionId: generateId(), actorUserId: users.platformAdmin!, orgId, expiresAt: new Date(Date.now() + 60000) } })));
      expect(await snapshot()).toEqual(before);
    });
    it(`${op}: platform admin on user-owned App remains outside #1734`, async () => {
      await forbidden(write(op, ctx('platformAdmin', { roles: ['ADMIN'] }), personalAppId));
    });
  }
  it('a key id belonging to an unmanaged App cannot be revoked', async () => {
    const key = await seedKey(personalAppId);
    await forbidden(M.revokeAppKey({}, { id: key.id }, ctx('admin')));
    expect((await db.appKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).toBeNull();
  });
});

describe('#1744 key inventory, direct and nested (including eager rows)', () => {
  for (const personal of [false, true]) {
    for (const name of ['owner', 'member', 'reader', 'admin', 'revoked', 'foreign', 'platformAdmin', 'userOwner']) {
      it(`${personal ? 'user' : 'org'} App inventory for ${name}`, async () => {
        const target = personal ? personalAppId : appId;
        const context = ctx(name, { roles: name === 'platformAdmin' ? ['ADMIN'] : ['READER'] });
        const allowed = personal ? ['owner', 'userOwner'].includes(name) : ['owner', 'admin', 'platformAdmin'].includes(name);
        const keys = await db.appKey.findMany({ where: { appId: target } });
        for (const read of [() => Q.appKeys({}, { appRef: target }, context), () => typeResolvers.App.keys({ id: target }, {}, context), () => typeResolvers.App.keys({ id: target, keys }, {}, context)]) {
          const promise = read();
          if (allowed) await expect(promise).resolves.toEqual(keys);
          else await forbidden(promise);
        }
      });
    }
  }
  it('impersonation cannot list keys even with an eager key list', async () => {
    const context = ctx('admin', { impersonation: { sessionId: generateId(), actorUserId: users.platformAdmin!, orgId, expiresAt: new Date(Date.now() + 60000) } });
    await forbidden(Q.appKeys({}, { appRef: appId }, context));
    await forbidden(typeResolvers.App.keys({ id: appId, keys: await snapshot() }, {}, context));
  });
});

describe('#1744 deciding membership is locked and rechecked before mint/revoke/rotate', () => {
  for (const op of writes) for (const kind of ['app-owner', 'org-admin'] as const) {
    it(`${op}: queued ${kind} revocation refuses with key rows unchanged`, async () => {
      const before = await snapshot();
      const name = kind === 'app-owner' ? 'owner' : 'admin';
      let release!: () => void;
      let held!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const locked = new Promise<void>((r) => { held = r; });
      const revoker = db.$transaction(async (tx) => {
        if (kind === 'app-owner') await tx.appMember.update({ where: { appId_userId: { appId, userId: users.owner! } }, data: { role: 'member' } });
        else await tx.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.admin! } }, data: { deletedAt: new Date() } });
        held();
        await gate;
      }, { timeout: 15000 });
      await locked;
      const pending = write(op, ctx(name)).then(() => null, (e: unknown) => e);
      try {
        await waitForLockWaitersOfType(db, 'transactionid', 1, 1500);
        release();
        await revoker;
        expect(await pending).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
        expect(await snapshot()).toEqual(before);
      } finally {
        release();
        await Promise.allSettled([revoker, pending]);
      }
    });
  }
});

describe('#1744 transport impersonation chokepoint remains intact', () => {
  for (const field of ['createAppKey', 'revokeAppKey', 'regenerateAppKey']) {
    it(`${field} is stopped by the read-only plugin`, async () => {
      const document = parse(`mutation { ${field} }`);
      const listener = await impersonationReadOnlyPlugin.requestDidStart!({} as never);
      const action = Promise.resolve().then(() => listener!.didResolveOperation!({ document, operation: document.definitions[0] as OperationDefinitionNode, contextValue: { impersonation: {} } } as never));
      await expect(action).rejects.toMatchObject({ extensions: { code: 'IMPERSONATION_READ_ONLY' } });
    });
  }
});

/** #2080 Rico P2-1: provisional audience refusal (Eden #22213), awaiting Holger's ruling. */
describe('#2080 bound worker actor cannot manage App credentials (provisional)', () => {
  for (const name of ['owner', 'admin']) {
    for (const op of writes) {
      it(`${op}: refuses a bound worker driven by ${name} with no credential changes`, async () => {
        const before = await snapshot();
        await runAsActor({ workerId: generateId(), agentId: generateId() }, async () => {
          await forbidden(write(op, ctx(name)));
        });
        expect(await snapshot()).toEqual(before);
      });
    }
    it(`inventory: refuses a bound worker driven by ${name} on direct and eager/fallback nested paths`, async () => {
      const keys = await db.appKey.findMany({ where: { appId } });
      await runAsActor({ workerId: generateId(), agentId: generateId() }, async () => {
        await forbidden(Q.appKeys({}, { appRef: appId }, ctx(name)));
        await forbidden(typeResolvers.App.keys({ id: appId }, {}, ctx(name)));
        await forbidden(typeResolvers.App.keys({ id: appId, keys }, {}, ctx(name)));
      });
    });
  }
  it('an org ADMIN without App membership still manages keys as a person', async () => {
    expect(await db.appMember.count({ where: { appId, userId: users.admin! } })).toBe(0);
    await runAsActor({ workerId: null, agentId: null }, async () => {
      await expect(write('mint', ctx('admin'))).resolves.toHaveProperty('rawKey');
      await expect(Q.appKeys({}, { appRef: appId }, ctx('admin'))).resolves.toBeTruthy();
      await expect(write('revoke', ctx('admin'))).resolves.toBe(true);
      await expect(write('rotate', ctx('admin'))).resolves.toHaveProperty('rawKey');
    });
  });
});
