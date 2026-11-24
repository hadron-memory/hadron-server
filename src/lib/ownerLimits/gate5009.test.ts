/** #5009 (Billing A7a): requireOwnerHeadroom, called directly on a real transaction. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { formatGraphQLError, isExpectedClientError, isTrustedRefusal } from '../../api/graphql/formatError.js';
import type { OwnerRef } from '../owner.js';
import { reloadOwnerDefaultLimitsForTests } from './defaults.js';
import { OwnerLimitReachedError } from './errors.js';
import { lockOwnerLimitKeys, requireOwnerHeadroom } from './gate.js';
import { OWNER_LIMIT_KEY_LIST, OWNER_LIMIT_KEYS, type OwnerLimitKey } from './keys.js';

let userU: string;
let orgId: string;
let agentId: string;
let appId: string;
let seq = 0;

const defaults = (value: unknown) => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify(value) });
const mkUser = async () => (await db.user.create({ data: { id: generateId(), handle: `own-limit-${++seq}` } })).id;
const personalMemory = (owner: string, data: Record<string, unknown> = {}) =>
  db.memory.create({ data: {
    id: generateId(), name: 'm', urn: `@o:m-${++seq}`, class: 'personal', ownerUserId: owner, userId: owner, organizationId: null, ...data,
  } as never });
const orgMemory = (data: Record<string, unknown> = {}) =>
  db.memory.create({ data: {
    id: generateId(), name: 'm', urn: `ol-org:m-${++seq}`, class: 'knowledge', organizationId: orgId, ...data,
  } as never });
const node = (memoryId: string, data: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: `n-${++seq}`, name: 'n', ...data } as never });
const addMember = (userId: string, role: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR', deletedAt: Date | null = null) =>
  db.orgMember.create({ data: { organizationId: orgId, userId, role, deletedAt } });
const call = (owner: OwnerRef, key: OwnerLimitKey, caller: { userId: string } | null, amount?: bigint) =>
  db.$transaction((tx) => requireOwnerHeadroom(tx, { owner, key, caller, amount }));
const refusal = async (p: Promise<unknown>): Promise<OwnerLimitReachedError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(OwnerLimitReachedError);
  return e as OwnerLimitReachedError;
};
const setRow = (owner: OwnerRef, key: string, limitValue: bigint | null) =>
  db.ownerLimit.create({ data: {
    id: generateId(), key, limitValue, sourceType: 'manual', sourceId: 't', note: 'n',
    organizationId: 'organizationId' in owner ? owner.organizationId : null,
    ownerUserId: 'userId' in owner ? owner.userId : null,
  } });

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  userU = await mkUser();
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ol-org', urn: 'ol-org' } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'a', urn: 'ol-org:a', organizationId: orgId } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'p', urn: 'ol-org:p', organizationId: orgId } as never })).id;
});
afterEach(() => { vi.restoreAllMocks(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5009 requireOwnerHeadroom: the limit and its refusal', () => {
  it('passes below the limit and refuses at it, naming the limited person their own limit', async () => {
    defaults({ user: { memories: 2 } });
    await personalMemory(userU);
    await call({ userId: userU }, 'memories', { userId: userU });
    await expect(call({ userId: userU }, 'memories', { userId: userU }, 2n)).rejects.toBeInstanceOf(OwnerLimitReachedError);
    await personalMemory(userU);
    const e = await refusal(call({ userId: userU }, 'memories', { userId: userU }));
    expect(e.message).toBe('Your account has reached its limit of 2 memories.');
    expect(e.extensions).toEqual({
      code: 'OWNER_LIMIT_REACHED', limitKey: 'memories', ownerType: 'user', callerCanManageOwner: true, ownerId: userU, limit: '2',
    });
  });

  it('a limit of 1 uses the singular noun; a zero amount never refuses, a negative one is a programming error', async () => {
    defaults({ user: { memories: 1 } });
    await personalMemory(userU);
    expect((await refusal(call({ userId: userU }, 'memories', { userId: userU }))).message)
      .toBe('Your account has reached its limit of 1 memory.');
    await personalMemory(userU);
    await call({ userId: userU }, 'memories', { userId: userU }, 0n);
    await expect(call({ userId: userU }, 'memories', { userId: userU }, -1n)).rejects.toThrow(/amount/);
  });

  it.each(['ADMIN', 'OWNER'] as const)('an org %s gets the owner id and the limit', async (role) => {
    defaults({ organization: { agents: 1 } });
    await addMember(userU, role);
    const e = await refusal(call({ organizationId: orgId }, 'agents', { userId: userU }));
    expect(e.message).toBe('This organization has reached its limit of 1 agent.');
    expect(e.extensions).toEqual({
      code: 'OWNER_LIMIT_REACHED', limitKey: 'agents', ownerType: 'organization', callerCanManageOwner: true, ownerId: orgId, limit: '1',
    });
  });

  it.each(['contributor', 'stranger', 'no caller', 'revoked admin', 'another person'])('%s gets neither id nor number', async (who) => {
    defaults({ organization: { agents: 1 }, user: { memories: 0 } });
    const caller = who === 'no caller' ? null : { userId: userU };
    if (who === 'contributor') await addMember(userU, 'CONTRIBUTOR');
    if (who === 'revoked admin') await addMember(userU, 'ADMIN', new Date());
    const person = who === 'another person';
    const owner: OwnerRef = person ? { userId: await mkUser() } : { organizationId: orgId };
    const e = await refusal(call(owner, person ? 'memories' : 'agents', caller));
    expect(e.message).toBe('The owner of this memory has reached a limit of their account.');
    expect(e.extensions).toEqual({
      code: 'OWNER_LIMIT_REACHED', limitKey: person ? 'memories' : 'agents', ownerType: person ? 'user' : 'organization', callerCanManageOwner: false,
    });
    expect(JSON.stringify({ m: e.message, ...e.extensions })).not.toMatch(/\d/);
  });
});

describe('#5009 the effective limit', () => {
  it('a row overrides the default, a null row lifts it, and an absent row and default take no lock', async () => {
    defaults({ user: { memories: 1 }, organization: { apps: 9 } });
    await personalMemory(userU);
    await refusal(call({ userId: userU }, 'memories', { userId: userU }));
    const row = await setRow({ userId: userU }, 'memories', 5n);
    await call({ userId: userU }, 'memories', { userId: userU });
    await db.ownerLimit.update({ where: { id: row.id }, data: { limitValue: null } });
    const locks = await db.$transaction(async (tx) => {
      await requireOwnerHeadroom(tx, { owner: { userId: userU }, key: 'memories', caller: null, amount: 1_000n });
      await requireOwnerHeadroom(tx, { owner: { userId: userU }, key: 'apps', caller: null, amount: 1_000n });
      const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
      return n;
    });
    expect(locks).toBe(0n);
  });

  it('the registry refuses nothing it does not know and the default is per owner type', async () => {
    defaults({ organization: { memories: 0 } });
    await call({ userId: userU }, 'memories', { userId: userU });
    await refusal(call({ organizationId: orgId }, 'memories', null));
  });
});

describe('#5009 what counts', () => {
  const used = (owner: OwnerRef, key: OwnerLimitKey) => db.$transaction((tx) => OWNER_LIMIT_KEYS[key].count(tx, owner));

  it('memories: free-standing shared and personal classes only, live, per owner', async () => {
    await orgMemory();
    await orgMemory({ class: 'group' });
    await orgMemory({ class: 'personal', userId: userU });
    await orgMemory({ class: 'private', userId: userU });
    await orgMemory({ class: 'system' });
    await orgMemory({ class: 'app', appId });
    await orgMemory({ appId });
    await orgMemory({ class: 'system', appId, isInstallMemory: true, installOfAgentId: agentId });
    await orgMemory({ deletedAt: new Date() });
    await personalMemory(userU);
    expect(await used({ organizationId: orgId }, 'memories')).toBe(4n);
    expect(await used({ userId: userU }, 'memories')).toBe(1n);
  });

  it('nodes: live nodes of live memories of any class', async () => {
    const live = await orgMemory();
    const app = await orgMemory({ class: 'app', appId });
    const dead = await orgMemory({ deletedAt: new Date() });
    await node(live.id); await node(live.id, { deletedAt: new Date() });
    await node(app.id); await node(dead.id);
    await node((await personalMemory(userU)).id);
    expect(await used({ organizationId: orgId }, 'nodes')).toBe(2n);
    expect(await used({ userId: userU }, 'nodes')).toBe(1n);
  });

  it('agents and apps: live rows of the owner', async () => {
    await db.agent.create({ data: { id: generateId(), name: 'd', urn: 'ol-org:d', organizationId: orgId, deletedAt: new Date() } });
    await db.agent.create({ data: { id: generateId(), name: 'u', urn: '@o:u', ownerUserId: userU, organizationId: null } as never });
    await db.app.create({ data: { id: generateId(), name: 'd', urn: 'ol-org:dp', organizationId: orgId, deletedAt: new Date() } as never });
    for (const key of ['agents', 'apps'] as const) expect(await used({ organizationId: orgId }, key)).toBe(1n);
    expect(await used({ userId: userU }, 'agents')).toBe(1n);
    expect(await used({ userId: userU }, 'apps')).toBe(0n);
  });
});

describe('#5009 concurrency', () => {
  async function waitForWaiter(pid: number) {
    for (const until = Date.now() + 8_000; Date.now() < until;) {
      const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}) AS waiting`;
      if (waiting) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('the second transaction never waited on the owner-limit lock');
  }

  /** A holds the helper's lock; B is proven to wait on it; A then runs `beforeCommit` and commits. Returns B's outcome. */
  async function race(beforeCommit: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let tellPid!: (n: number) => void;
    const bPid = new Promise<number>((r) => { tellPid = r; });
    let b: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await requireOwnerHeadroom(tx, { owner: { userId: userU }, key: 'memories', caller: null });
      b = db.$transaction(async (tx2) => {
        const [{ pid }] = await tx2.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        tellPid(pid);
        await requireOwnerHeadroom(tx2, { owner: { userId: userU }, key: 'memories', caller: { userId: userU } });
      }, { timeout: 20_000 });
      b.catch(() => {});
      await waitForWaiter(await bPid);
      await beforeCommit(tx);
    }, { timeout: 20_000 });
    return b!.then(() => 'passed', (e: unknown) => e);
  }

  it('two calls at one below the limit end with exactly one pass', async () => {
    defaults({ user: { memories: 1 } });
    const b = await race((tx) => tx.memory.create({ data: {
      id: generateId(), name: 'm', urn: '@o:race', class: 'personal', ownerUserId: userU, userId: userU, organizationId: null,
    } as never }));
    expect(b).toBeInstanceOf(OwnerLimitReachedError);
    expect(await db.memory.count({ where: { ownerUserId: userU } })).toBe(1);
  });

  it('the limit is read again after the wait', async () => {
    await setRow({ userId: userU }, 'memories', 1n);
    const b = await race((tx) => tx.ownerLimit.updateMany({ where: { ownerUserId: userU }, data: { limitValue: 0n } }));
    expect((b as OwnerLimitReachedError).extensions.limit).toBe('0');
  });

  it('a limit lifted during the wait lets the waiter through', async () => {
    await setRow({ userId: userU }, 'memories', 1n);
    const b = await race(async (tx) => {
      await tx.memory.create({ data: {
        id: generateId(), name: 'm', urn: '@o:race', class: 'personal', ownerUserId: userU, userId: userU, organizationId: null,
      } as never });
      await tx.ownerLimit.updateMany({ where: { ownerUserId: userU }, data: { limitValue: null } });
    });
    expect(b).toBe('passed');
  });

  it('a REPEATABLE READ caller is a programming error, not a refusal', async () => {
    defaults({ user: { memories: 5 } });
    const p = db.$transaction(
      (tx) => requireOwnerHeadroom(tx, { owner: { userId: userU }, key: 'memories', caller: null }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await expect(p).rejects.toThrow(/REPEATABLE READ/);
    await expect(p).rejects.not.toBeInstanceOf(GraphQLError);
  });

  it('locks every key in the resolved hash order, whatever order the caller gave', async () => {
    const seen: unknown[][] = [];
    const run = (keys: OwnerLimitKey[]) => db.$transaction(async (tx) => {
      const calls: unknown[] = [];
      await lockOwnerLimitKeys(new Proxy(tx, { get(t, p, r) {
        if (p !== '$executeRaw') return Reflect.get(t, p, r);
        return (sql: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); return tx.$executeRaw(sql, ...values); };
      } }), { userId: userU }, keys);
      seen.push(calls);
    });
    await run([...OWNER_LIMIT_KEY_LIST]);
    await run([...OWNER_LIMIT_KEY_LIST].reverse());
    expect(seen[0]).toHaveLength(OWNER_LIMIT_KEY_LIST.length);
    expect(seen[1]).toEqual(seen[0]);
  });
});

describe('#5009 the refusal on the wire, and the table', () => {
  it('is a trusted, expected client refusal whose extensions survive the formatter', () => {
    const e = new OwnerLimitReachedError({ key: 'nodes', owner: { userId: 'u' }, limit: 3n, callerCanManageOwner: true });
    expect(isTrustedRefusal(e)).toBe(true);
    expect(isExpectedClientError(e)).toBe(true);
    const out = formatGraphQLError({ message: e.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }, e);
    expect(out.message).toBe('Your account has reached its limit of 3 nodes.');
    expect(out.extensions).toMatchObject({ code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', ownerType: 'user', ownerId: 'u', limit: '3' });
  });

  it('the CHECKs have one source: the migration ends with the file post-push.sql includes', () => {
    const guard = readFileSync('prisma/owner-limit-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261124130000_owner_limits/migration.sql', 'utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir owner-limit-invariants.sql');
  });

  it.each([
    ['both owners', { organizationId: true, ownerUserId: true }],
    ['no owner', {}],
    ['a negative limit', { ownerUserId: true, limitValue: -1n }],
    ['a blank note', { ownerUserId: true, note: ' ' }],
    ['a blank source type', { ownerUserId: true, sourceType: ' ' }],
    ['a blank source id', { ownerUserId: true, sourceId: '' }],
    ['a blank key', { ownerUserId: true, key: '' }],
  ])('the database refuses %s', async (_name, over: Record<string, unknown>) => {
    const { organizationId, ownerUserId, ...rest } = over;
    await expect(db.ownerLimit.create({ data: {
      id: generateId(), key: 'nodes', limitValue: 1n, sourceType: 's', sourceId: 'i', note: 'n',
      organizationId: organizationId ? orgId : null, ownerUserId: ownerUserId ? userU : null, ...rest,
    } as never })).rejects.toThrow(/chk_owner_limits_/);
  });
});
