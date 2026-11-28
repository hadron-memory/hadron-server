/**
 * #5434 (owner limits, Holger's answer A on cor:acl:150:02): the nodes a user writes in their personal memory made under an Agent
 * (`memories.user_memory_of_agent_id` set, class personal or private, so `user_id` is set) count toward THAT USER's `nodes` limit and
 * not toward the Agent's organization. One shared "counts-for" owner decides it, for the count (both paths) and for every door; the
 * stored owner (`organization_id` / `owner_user_id`) is NOT changed. `nodeBytes` and `assetBytes` stay as stored (open for Holger).
 *
 * RED on main: the count and every door judge these nodes against the stored owner (the Agent's organization).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersBlockedBy } from '../../../test/lockWait.js';
import { expectNodeTotalsExact } from '../../../test/nodeTotals.js';
import { generateId } from '../../../lib/id.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { lockOwnerLimitKeys } from '../../../lib/ownerLimits/gate.js';
import { countOwnerNodesOnDemand, OWNER_LIMIT_KEYS } from '../../../lib/ownerLimits/keys.js';
import { memoryOwnerInTx, sameMemoryOwner } from '../../../lib/ownerLimits/nodes.js';
import { countsForOwnerOf, isPerUserAgentMemory } from '../../../lib/ownerLimits/countsFor.js';
import type { OwnerRef } from '../../../lib/owner.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());
interface Result { data?: Record<string, any> | null; errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }> }
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>): Promise<Result> {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult as Result;
}
const CREATE = `mutation($input: CreateNodeInput!) { createNode(input: $input) { id loc } }`;
const MOVE = `mutation($src: ID!, $to: ID!) { moveNode(sourceRef: $src, targetMemoryRef: $to) { id } }`;
const TRANSFER = `mutation($ref: ID!, $org: ID) { transferMemoryOwnership(memoryRef: $ref, orgRef: $org, targetClass: knowledge) { memoryId } }`;
const CLONE_MEMORY = `mutation($ref: ID!, $urn: String!) { cloneMemory(ref: $ref, targetUrn: $urn) { id } }`;
const EXTRACT = `mutation($ref: ID!, $urn: String!, $move: Boolean) { extractParentNodeToMemory(parentRef: $ref, targetUrn: $urn, move: $move) { id } }`;
const LIMITS = `query($orgRef: String, $userRef: ID) { ownerLimits(orgRef: $orgRef, userRef: $userRef) { key limit used } }`;
const ctxOf = (userId: string): Partial<Context> => ({ userId, roles: ['READER'] as never });
const code = (r: Result) => r.errors?.[0]?.extensions?.code ?? null;
const used = (owner: OwnerRef) => OWNER_LIMIT_KEYS.nodes.count(db, owner);
const limitWhere = (owner: OwnerRef) => ('userId' in owner ? { ownerUserId: owner.userId } : { organizationId: owner.organizationId });
/** Put an owner exactly at its `nodes` limit (room for `room` more). */
async function cap(owner: OwnerRef, room = 0n) {
  await db.ownerLimit.create({ data: { id: generateId(), ...limitWhere(owner), key: 'nodes', limitValue: (await used(owner)) + room, sourceType: 'manual', sourceId: generateId(), note: 't' } });
}
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `Body ${loc}`, ...extra } as never });
const nodes = (memoryId: string, locs: string[]) => Promise.all(locs.map((l) => node(memoryId, l)));

let u: string, v: string, x: string, orgId: string, orgUrn: string;
let agentId: string, agentId2: string, userAgentId: string;
let pm: string; // u's personal memory under the org's Agent (stored owner: the organization)
let pm2: string; // u's personal memory under a second org Agent
let pmUserAgent: string; // u's personal memory under an Agent that person x owns (stored owner: x)
let mU: string; // u's own free-standing personal memory
let mO: string; // an organization knowledge memory
let mV: string; // v's per-Agent memory (another user)

const mem = (data: Record<string, unknown>) => db.memory.create({ data: { id: generateId(), vectorIndexEnabled: false, ...data } as never }).then((m) => m.id);

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  const person = async (n: string) => (await db.user.create({ data: { id: generateId(), handle: `c5434-${n}`, email: `c5434-${n}@example.test`, roles: ['READER'] } })).id;
  [u, v, x] = [await person('u'), await person('v'), await person('x')];
  orgUrn = 'c5434-org';
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'c5434', urn: orgUrn } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: v, role: 'READER' } });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'A1', urn: `${orgUrn}:a1`, organizationId: orgId } })).id;
  agentId2 = (await db.agent.create({ data: { id: generateId(), name: 'A2', urn: `${orgUrn}:a2`, organizationId: orgId } })).id;
  userAgentId = (await db.agent.create({ data: { id: generateId(), name: 'UA', urn: `c5434-x:ua`, ownerUserId: x } })).id;
  pm = await mem({ name: 'pm', urn: `${orgUrn}:pm`, class: 'personal', userId: u, organizationId: orgId, userMemoryOfAgentId: agentId });
  pm2 = await mem({ name: 'pm2', urn: `${orgUrn}:pm2`, class: 'personal', userId: u, organizationId: orgId, userMemoryOfAgentId: agentId2 });
  pmUserAgent = await mem({ name: 'pmua', urn: `c5434-x:pmua`, class: 'personal', userId: u, ownerUserId: x, userMemoryOfAgentId: userAgentId });
  mU = await mem({ name: 'mu', urn: `c5434-u:mu`, class: 'personal', userId: u, ownerUserId: u });
  mO = await mem({ name: 'mo', urn: `${orgUrn}:mo`, class: 'knowledge', organizationId: orgId, visibility: 'ORGANIZATION' });
  mV = await mem({ name: 'mv', urn: `${orgUrn}:mv`, class: 'personal', userId: v, organizationId: orgId, userMemoryOfAgentId: agentId });
});
afterEach(() => {
  vi.unstubAllEnvs();
  reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' });
});

describe('#5434 pin 1: the count', () => {
  // org: mO 2 nodes (counts), pm 3, pm2 1, mV 2 (all per-user: do not count for the org); u: mU 1, pm 3, pm2 1, pmUserAgent 4 (per-user: counts for u)
  beforeEach(async () => {
    await nodes(mO, ['a', 'b']);
    await nodes(pm, ['a', 'b', 'c']);
    await nodes(pm2, ['a']);
    await nodes(mV, ['a', 'b']);
    await nodes(mU, ['a']);
    await nodes(pmUserAgent, ['a', 'b', 'c', 'd']);
  });

  it.each([['totals', ''], ['on-demand', 'on-demand']])('%s: the organization counts its own memories only; each user counts their per-Agent memories, whoever owns the Agent', async (_name, source) => {
    vi.stubEnv('OWNER_NODE_COUNT_SOURCE', source);
    expect(await used({ organizationId: orgId })).toBe(2n);
    expect(await used({ userId: u })).toBe(1n + 3n + 1n + 4n); // mU, pm, pm2, pmUserAgent
    expect(await used({ userId: v })).toBe(2n); // mV
    expect(await used({ userId: x })).toBe(0n); // the Agent's owner does not pay for the end user's nodes
  });

  it('on-demand equals the totals for every owner (the #5078 differential), for these memories too', async () => {
    await expectNodeTotalsExact(db);
    for (const owner of [{ organizationId: orgId }, { userId: u }, { userId: v }, { userId: x }] as OwnerRef[]) {
      vi.stubEnv('OWNER_NODE_COUNT_SOURCE', '');
      const fromTotals = await used(owner);
      expect(fromTotals).toBe(await countOwnerNodesOnDemand(db, owner));
    }
  });

  it('a deleted node and a deleted memory stop counting for the user, as for any owner', async () => {
    await db.node.updateMany({ where: { memoryId: pm, loc: 'a' }, data: { deletedAt: new Date() } });
    expect(await used({ userId: u })).toBe(1n + 2n + 1n + 4n);
    await db.memory.update({ where: { id: pm2 }, data: { deletedAt: new Date() } });
    expect(await used({ userId: u })).toBe(1n + 2n + 4n);
    await expectNodeTotalsExact(db);
  });

  it('the stored owner is unchanged: a per-Agent memory still names the Agent\'s organization (or the Agent\'s owner) in its columns', async () => {
    const a = await db.memory.findUniqueOrThrow({ where: { id: pm }, select: { organizationId: true, ownerUserId: true, userId: true } });
    expect(a).toEqual({ organizationId: orgId, ownerUserId: null, userId: u });
    const b = await db.memory.findUniqueOrThrow({ where: { id: pmUserAgent }, select: { organizationId: true, ownerUserId: true, userId: true } });
    expect(b).toEqual({ organizationId: null, ownerUserId: x, userId: u });
  });

  it('nodeBytes stays as stored (the Agent\'s organization), not following nodes (open for Holger via Vera): a guard pin, green on main', async () => {
    const storedSum = async (col: 'organization_id' | 'owner_user_id', id: string) => {
      const [{ n }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COALESCE(SUM(COALESCE(n.stored_bytes, 0)::bigint + COALESCE(n.revision_bytes, 0)), 0)::bigint AS n
         FROM nodes n JOIN memories o ON o.id = n.memory_id WHERE o.${col} = $1 AND o.deleted_at IS NULL AND n.deleted_at IS NULL`, id);
      return n;
    };
    expect(await OWNER_LIMIT_KEYS.nodeBytes.count(db, { organizationId: orgId })).toBe(await storedSum('organization_id', orgId));
    expect(await OWNER_LIMIT_KEYS.nodeBytes.count(db, { userId: u })).toBe(await storedSum('owner_user_id', u));
    expect(await storedSum('organization_id', orgId)).toBeGreaterThan(0n); // the organization's bytes still include pm's nodes
  });

  it('Query.ownerLimits reports the same figure for both owners', async () => {
    const asU = ctxOf(u);
    const org = await gql(LIMITS, asU, { orgRef: orgId });
    const person = await gql(LIMITS, asU, { userRef: u });
    const usedOf = (r: Result) => BigInt(r.data!.ownerLimits.find((k: { key: string }) => k.key === 'nodes').used);
    expect(usedOf(org)).toBe(2n);
    expect(usedOf(person)).toBe(9n);
  });
});

describe('#5434 pin 2: the doors judge the user, not the Agent\'s organization', () => {
  it('the N+1th node in the user\'s per-Agent memory is refused for the USER at their limit', async () => {
    await nodes(mU, ['a']);
    await nodes(pm, ['a']);
    await cap({ userId: u });
    expect(code(await gql(CREATE, ctxOf(u), { input: { memoryRef: pm, loc: 'z', name: 'z' } }))).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: pm, loc: 'z' } })).toBe(0);
  });

  it('the Agent\'s organization at its limit does NOT refuse a write into the user\'s per-Agent memory', async () => {
    await nodes(mO, ['a', 'b']);
    await nodes(pm, ['a']);
    await cap({ organizationId: orgId }); // the organization is at its limit
    const r = await gql(CREATE, ctxOf(u), { input: { memoryRef: pm, loc: 'z', name: 'z' } });
    expect((r.errors ?? []).map((e) => `${e.extensions?.code}: ${e.message}`).join(' | ')).toBe('');
    expect(await used({ organizationId: orgId })).toBe(2n); // unchanged: the node counts for the user
    // and the organization's own memory is still refused at that limit (the guard against over-refusal in the other direction)
    expect(code(await gql(CREATE, ctxOf(u), { input: { memoryRef: mO, loc: 'z', name: 'z' } }))).toBe('OWNER_LIMIT_REACHED');
  });

  it('a user with room writes into their per-Agent memory and the node counts for them', async () => {
    await cap({ userId: u }, 1n);
    const before = await used({ userId: u });
    expect(((await gql(CREATE, ctxOf(u), { input: { memoryRef: pm, loc: 'z', name: 'z' } })).errors ?? []).map((e) => `${e.extensions?.code}: ${e.message}`).join(' | ')).toBe('');
    expect(await used({ userId: u })).toBe(before + 1n);
    expect(code(await gql(CREATE, ctxOf(u), { input: { memoryRef: pm2, loc: 'y', name: 'y' } }))).toBe('OWNER_LIMIT_REACHED');
  });

  it('a per-Agent memory of an Agent a person owns counts for the end user, not for the Agent\'s owner', async () => {
    await cap({ userId: x });
    expect(((await gql(CREATE, ctxOf(u), { input: { memoryRef: pmUserAgent, loc: 'z', name: 'z' } })).errors ?? []).map((e) => `${e.extensions?.code}: ${e.message}`).join(' | ')).toBe('');
    await cap({ userId: u });
    expect(code(await gql(CREATE, ctxOf(u), { input: { memoryRef: pmUserAgent, loc: 'y', name: 'y' } }))).toBe('OWNER_LIMIT_REACHED');
  });
});

describe('#5434 pin 3: a move or merge uses the same counts-for owner', () => {
  it('the helpers: a per-Agent memory\'s counts-for owner is its user; same owner as the user\'s own memory, not as the organization\'s', async () => {
    await db.$transaction(async (tx) => {
      expect(await memoryOwnerInTx(tx, pm)).toEqual({ userId: u });
      expect(await memoryOwnerInTx(tx, pmUserAgent)).toEqual({ userId: u });
      expect(await memoryOwnerInTx(tx, mO)).toEqual({ organizationId: orgId });
      expect(await sameMemoryOwner(tx, pm, mU)).toBe(true);
      expect(await sameMemoryOwner(tx, pm, pm2)).toBe(true);
      expect(await sameMemoryOwner(tx, pm, mO)).toBe(false);
      expect(await sameMemoryOwner(tx, pm, mV)).toBe(false); // another user's
    });
  });

  it('a move from the per-Agent memory into the user\'s own memory needs no headroom: the user at their limit succeeds', async () => {
    const [n] = await nodes(pm, ['a']);
    await cap({ userId: u });
    expect(((await gql(MOVE, ctxOf(u), { src: n.id, to: mU })).errors ?? []).map((e) => `${e.extensions?.code}: ${e.message}`).join(' | ')).toBe('');
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).memoryId).toBe(mU);
  });

  it('a move from the per-Agent memory into an ORGANIZATION memory needs the organization\'s headroom', async () => {
    const [n] = await nodes(pm, ['p']);
    await nodes(mO, ['a']);
    await cap({ organizationId: orgId });
    expect(code(await gql(MOVE, ctxOf(u), { src: n.id, to: mO }))).toBe('OWNER_LIMIT_REACHED');
    await db.ownerLimit.updateMany({ where: { organizationId: orgId, key: 'nodes' }, data: { limitValue: 5n } });
    expect(((await gql(MOVE, ctxOf(u), { src: n.id, to: mO })).errors ?? []).map((e) => `${e.extensions?.code}: ${e.message}`).join(' | ')).toBe('');
    expect(await used({ organizationId: orgId })).toBe(2n);
  });

  it('a move from an organization memory into the per-Agent memory needs the USER\'s headroom, not the organization\'s', async () => {
    const [n] = await nodes(mO, ['a']);
    await nodes(mU, ['a']);
    await cap({ userId: u });
    expect(code(await gql(MOVE, ctxOf(u), { src: n.id, to: pm }))).toBe('OWNER_LIMIT_REACHED');
    await db.ownerLimit.updateMany({ where: { ownerUserId: u, key: 'nodes' }, data: { limitValue: 5n } });
    await cap({ organizationId: orgId }); // the organization at its limit does not matter
    expect(((await gql(MOVE, ctxOf(u), { src: n.id, to: pm })).errors ?? []).map((e) => `${e.extensions?.code}: ${e.message}`).join(' | ')).toBe('');
  });

  it('extracting a node out of the per-Agent memory into a new organization memory adds to the organization', async () => {
    const [n] = await nodes(pm, ['a', 'q']); // a node outside the extracted subtree stays, so the move does not empty the source
    await nodes(mO, ['a']);
    await cap({ organizationId: orgId });
    const r = await gql(EXTRACT, ctxOf(u), { ref: n.id, urn: `hrn:mem:${orgUrn}:extracted`, move: true });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
  });
});

describe('#5434 pin 4: the user\'s limit key is the one taken, last, for a write into the per-Agent memory', () => {
  it('two creates in two per-Agent memories of one user at one below the cap, parked on the USER\'s owner key: exactly one commits', async () => {
    const owner = { userId: u };
    await cap(owner, 1n);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: (pid: number) => void;
    const held = new Promise<number>((r) => { ready = r; });
    const done = db.$transaction(async (tx) => {
      await lockOwnerLimitKeys(tx, owner, ['nodes']);
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      ready(pid);
      await gate;
    }, { timeout: 30_000 });
    const pid = await held;
    const racers = [pm, pm2].map((m, i) => gql(CREATE, ctxOf(u), { input: { memoryRef: m, loc: `r${i}`, name: `r${i}`, seq: 10 + i } }).then((r) => code(r) ?? 'ok'));
    try {
      await waitForLockWaitersBlockedBy(db, pid, 2);
    } finally {
      release();
      await done;
    }
    expect((await Promise.all(racers)).sort()).toEqual(['OWNER_LIMIT_REACHED', 'ok']);
    expect(await used(owner)).toBe(await countOwnerNodesOnDemand(db, owner));
  });
});

describe('#5434 pin 5: the row-level rule and the SQL count are one rule', () => {
  it('for every memory shape, the owner countsForOwnerOf names is the owner whose count includes the node, and nobody else\'s', async () => {
    const shapes: Array<[string, Record<string, unknown>]> = [
      ['organization knowledge', { name: 's1', urn: `${orgUrn}:s1`, class: 'knowledge', organizationId: orgId, visibility: 'ORGANIZATION' }],
      ['a person\'s own free-standing memory', { name: 's2', urn: `c5434-u:s2`, class: 'knowledge', ownerUserId: u }],
      ['a person\'s own personal memory', { name: 's3', urn: `c5434-u:s3`, class: 'personal', userId: u, ownerUserId: u }],
      ['per-Agent personal, organization Agent', { name: 's4', urn: `${orgUrn}:s4`, class: 'personal', userId: v, organizationId: orgId, userMemoryOfAgentId: agentId }],
      ['per-Agent private, organization Agent', { name: 's5', urn: `${orgUrn}:s5`, class: 'private', userId: v, organizationId: orgId, userMemoryOfAgentId: agentId2 }],
      ['per-Agent personal, person-owned Agent', { name: 's6', urn: `c5434-x:s6`, class: 'personal', userId: v, ownerUserId: x, userMemoryOfAgentId: userAgentId }],
      // SEC10 survivor (per-Agent AND -> OR): an Agent is set but NO user, so the stored owner still decides (anonymous / legacy holding).
      ['agent set, no user, organization-owned', { name: 's7', urn: `${orgUrn}:s7`, class: 'knowledge', organizationId: orgId, userMemoryOfAgentId: agentId }],
      ['agent set, no user, person-owned', { name: 's8', urn: `c5434-x:s8`, class: 'knowledge', ownerUserId: x, userMemoryOfAgentId: userAgentId }],
    ];
    const owners: OwnerRef[] = [{ organizationId: orgId }, { userId: u }, { userId: v }, { userId: x }];
    for (const [label, data] of shapes) {
      const id = await mem(data);
      await node(id, 'only');
      const row = await db.memory.findUniqueOrThrow({ where: { id }, select: { organizationId: true, ownerUserId: true, userId: true, userMemoryOfAgentId: true } });
      const expected = countsForOwnerOf(row)!;
      for (const owner of owners) {
        const before = await countOwnerNodesOnDemand(db, owner);
        await db.node.update({ where: { loc_memoryId: { loc: 'only', memoryId: id } }, data: { deletedAt: new Date() } });
        const after = await countOwnerNodesOnDemand(db, owner);
        await db.node.update({ where: { loc_memoryId: { loc: 'only', memoryId: id } }, data: { deletedAt: null } });
        const counts = before - after === 1n;
        const same = ('userId' in owner && 'userId' in expected && owner.userId === expected.userId)
          || ('organizationId' in owner && 'organizationId' in expected && owner.organizationId === expected.organizationId);
        expect(counts, `${label}: ${JSON.stringify(owner)}`).toBe(same);
      }
      expect(isPerUserAgentMemory(row), label).toBe(label.startsWith('per-Agent'));
    }
  });
});

describe('#5434 pin 6: the doors that name an owner themselves cannot reach a per-Agent memory\'s nodes through another owner', () => {
  it('a per-Agent memory cannot be transferred to another organization the owner administers (the receiving owner is never asked for its nodes)', async () => {
    await nodes(pm, ['a']);
    const org2 = (await db.organization.create({ data: { id: generateId(), name: 'c5434-2', urn: 'c5434-org2' } })).id;
    await db.orgMember.create({ data: { organizationId: org2, userId: u, role: 'OWNER' } });
    const r = await gql(TRANSFER, ctxOf(u), { ref: pm, org: org2 });
    expect(`${code(r)}: ${r.errors?.[0]?.message}`).toMatch(/Agent/i);
    expect((await db.memory.findUniqueOrThrow({ where: { id: pm } })).organizationId).toBe(orgId);
  });

  it('a clone of a per-Agent memory is an ordinary memory of the target organization: its nodes count for the organization and are refused at its limit', async () => {
    await nodes(pm, ['a', 'b']);
    await nodes(mO, ['a']);
    await cap({ organizationId: orgId });
    const r = await gql(CLONE_MEMORY, ctxOf(u), { ref: pm, urn: `hrn:mem:${orgUrn}:cloned` });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
  });
});
