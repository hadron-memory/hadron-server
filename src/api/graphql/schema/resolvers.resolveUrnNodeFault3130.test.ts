/**
 * #3130 — the GraphQL twins of #2975. `resolveUrn`'s NODE arm and the ACTION
 * arm's register-entry lookup both wrap `resolveNodeRefForCaller` in a catch
 * that rethrew only `AmbiguousLegacyUrnError` and answered `null` for anything
 * else, so a database fault inside the node-ref resolver answered exactly like
 * a ref that names nothing (cor:api:260:01: an internal error never becomes
 * "not found").
 *
 * The fault pins fault the node-ref resolver's memory-prefix lookup (the
 * `db.memory.findFirst` whose `where.urn` is `{ in: [...] }`) and require the
 * generic internal-fault envelope over the real /graphql wire. The refusal
 * side stays byte-identical (cor:api:140:03): unknown, malformed, not-yours
 * and a concealed ambiguity all answer `null`, and for an outsider unknown
 * and not-yours are indistinguishable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null, writtenNodes: [] }),
}));
vi.mock('../../../integrations/github/pushMemoryToGit.js', () => ({
  pushMemoryToGit: vi.fn().mockResolvedValue({ error: null }),
}));

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: { resolveUrn: unknown } | null | undefined; errors: GqlError[] | undefined };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = 'task.fault.3130';
const QUERY = 'query R($urn: String!) { resolveUrn(urn: $urn) { kind id } }';

let server: Server;
let baseUrl: string;
const key: Record<string, string> = {};
const urn: Record<'node' | 'action', { mine: string; unknown: string }> = {} as never;
let concealedAmbiguous = '';
let agentUrn = '';

async function gql(principal: string, u: string): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key[principal]}` },
    body: JSON.stringify({ query: QUERY, variables: { urn: u } }),
  });
  const body = (await response.json()) as { data?: Gql['data']; errors?: GqlError[] };
  return { status: response.status, data: body.data, errors: body.errors };
}

/**
 * Reject the FIRST call of `model.method` whose args satisfy `match` with a
 * plain Error (cor:api:260:01: a plain Error is a fault whatever its text),
 * and pass everything else through. Returns a probe for whether it fired.
 */
function faultOnce(model: string, method: string, match: (args: any) => boolean) {
  const delegate = (db as any)[model];
  const real = delegate[method].bind(delegate) as (a: unknown) => Promise<unknown>;
  const state = { fired: false };
  vi.spyOn(delegate, method).mockImplementation(((a: any) => {
    if (!state.fired && match(a)) {
      state.fired = true;
      return Promise.reject(new Error('db down 3130 private-detail'));
    }
    return real(a);
  }) as any);
  return state;
}

/** The node-ref resolver's memory-prefix lookup: `where.urn` is `{ in: [...] }`, not a string. */
const faultNodeRefLookup = () =>
  faultOnce('memory', 'findFirst', (a) => Array.isArray(a?.where?.urn?.in));

const ARMS = ['node', 'action'] as const;

beforeAll(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: 'fault org', urn: `fault3130-${s}` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other org', urn: `fault3130-other-${s}` } });
  const owner = await db.user.create({ data: { id: generateId(), handle: `f3130-owner-${s}`, githubUsername: `f3130-owner-${s}`, roles: ['READER'] } });
  const outsider = await db.user.create({ data: { id: generateId(), handle: `f3130-out-${s}`, githubUsername: `f3130-out-${s}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const ownerCtx: Context = { db, userId: owner.id, roles: ['READER'] };
  const created = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Fault Agent' }, ownerCtx);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  agentUrn = agent.urn;
  const sysMem = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId as string } });
  await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: `register:${CODE}`, name: CODE, content: 'entry' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:fault-mem`, name: 'fault-mem', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const nodeA = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'fault-node', name: 'fault-node', content: 'a' } });
  const nodeB = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'fault-node-b', name: 'fault-node-b', content: 'b' } });

  urn.node = { mine: emitNodeUrnV2(memory.urn, 'fault-node'), unknown: emitNodeUrnV2(memory.urn, 'no-such-node') };
  urn.action = { mine: `hrn:action:${agent.urn}:${CODE}`, unknown: `hrn:action:${agent.urn}:no.such.code` };

  // Two live nodes both hold one OLD node address (#1079 node-alias map). For
  // a caller who can read neither claimant, resolveNodeRefForCaller conceals
  // the ambiguity as NodeNotFoundError: the uniform null.
  await db.urnAlias.createMany({
    data: [nodeA.id, nodeB.id].map((entityId) => ({
      urn: `${memory.urn}:old-node`, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const,
    })),
  });
  concealedAmbiguous = emitNodeUrnV2(memory.urn, 'old-node');

  const mint = async (userId: string, label: string) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  key.owner = await mint(owner.id, 'owner');
  key.outsider = await mint(outsider.id, 'outsider');

  const httpApp = await createServer();
  server = createHttpServer(httpApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  // #3169: a beforeAll that throws before `server` is assigned must report only
  // its own failure, not a second TypeError from closing an unset server.
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function expectFaultEnvelope(r: Gql, label: string) {
  expect(r.data?.resolveUrn ?? null, `${label}: not answered as not-found`).toBeNull();
  expect(r.errors, `${label}: an error, not a silent null`).toHaveLength(1);
  const [err] = r.errors!;
  expect(err!.message).toBe('Internal server error.');
  expect(err!.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  expect(err!.extensions?.requestId).toMatch(UUID);
  expect(JSON.stringify(r)).not.toContain('private-detail');
}

describe('#3130 resolveUrn node arm and action-arm entry lookup: a fault is a fault, not "not found"', () => {
  it.each(ARMS)('control: the owner resolves the %s fixture with no fault', async (arm) => {
    const r = await gql('owner', urn[arm].mine);
    expect(r.errors, arm).toBeUndefined();
    expect(r.data?.resolveUrn, arm).toMatchObject({ kind: arm === 'node' ? 'node' : 'action' });
  });

  it('node arm: a DB fault in the node-ref lookup surfaces the generic internal-fault envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = faultNodeRefLookup();
    const r = await gql('owner', urn.node.mine);
    expect(probe.fired, 'the fault was injected').toBe(true);
    expectFaultEnvelope(r, 'node');
  });

  it('action arm: with the agent resolved, a DB fault in the register-entry lookup surfaces the generic envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The agent lookup is `agent.findFirst` with a string `where.urn`; it is
    // NOT faulted, so the arm reaches the entry lookup, whose node-ref memory
    // prefix lookup is the first `memory.findFirst` with `where.urn.in`.
    const agentLookups: unknown[] = [];
    const realAgent = db.agent.findFirst.bind(db.agent) as (a: unknown) => Promise<unknown>;
    vi.spyOn(db.agent, 'findFirst').mockImplementation(((a: any) => {
      if (typeof a?.where?.urn === 'string') agentLookups.push(a.where.urn);
      return realAgent(a);
    }) as any);
    const probe = faultNodeRefLookup();
    const r = await gql('owner', urn.action.mine);
    expect(agentLookups.length, 'the agent lookup ran (and succeeded) first').toBeGreaterThan(0);
    expect(probe.fired, 'the fault was injected in the entry lookup').toBe(true);
    expectFaultEnvelope(r, 'action');
  });
});

describe('#3130 resolveUrn node / action entry: refusals stay byte-identical', () => {
  it.each(ARMS)('%s arm: an unknown ref answers null with no error', async (arm) => {
    const r = await gql('owner', urn[arm].unknown);
    expect(r, arm).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });

  it('malformed node and action refs name nothing: null with no error', async () => {
    for (const u of [
      'hrn:node:no-root-only', // not fully qualified
      `hrn:node:${agentUrn}`, // a memory-less shape
      `hrn:action:${agentUrn}:BAD CODE!`, // charset
    ]) {
      const r = await gql('owner', u);
      expect(r, u).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
    }
  });

  it('control: the ambiguity fixture is real (the owner, who reads a claimant, gets the loud refusal)', async () => {
    const r = await gql('owner', concealedAmbiguous);
    expect(r.data?.resolveUrn ?? null).toBeNull();
    expect(r.errors?.[0]?.extensions?.code).toBe('AmbiguousLegacyUrnError');
  });

  it('node arm: a concealed ambiguity (outsider reads no claimant) answers null with no error and no logged fault', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await gql('outsider', concealedAmbiguous);
    expect(r).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(ARMS)('oracle: for an outsider, %s not-yours and unknown are byte-identical', async (arm) => {
    const mine = await gql('outsider', urn[arm].mine);
    const unknown = await gql('outsider', urn[arm].unknown);
    expect(mine).toEqual(unknown);
    expect(mine).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });
});
