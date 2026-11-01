/**
 * #2975 — `resolveUrn`'s entity arms must not turn an operational fault into
 * "not found" (cor:api:260:01: an internal error never becomes not-found).
 *
 * Six arms (memory, org, agent, action, app, user) wrapped their ref resolver
 * in a bare `catch { return null }`, so a database fault inside the resolver
 * answered exactly like a ref that names nothing. These pins fault the
 * resolver's own lookup and require the generic internal-fault envelope over
 * the real /graphql wire (formatError included). The refusal side stays
 * byte-identical: unknown, malformed and not-yours all answer `null`, and
 * unknown vs not-yours are indistinguishable (the existence-oracle property).
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
import { normalizeUrnForLookup, parseUrnInput } from '../../../lib/urn.js';

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
const CODE = 'task.fault.2975';
const QUERY = 'query R($urn: String!) { resolveUrn(urn: $urn) { kind id } }';

let server: Server;
let baseUrl: string;
const key: Record<string, string> = {};
/** Per arm: a URN the owner resolves, the same URN shape naming nothing, and a URN of the arm's kind the outsider cannot read. */
const urn: Record<string, { mine: string; unknown: string }> = {};
/** Per arm: an OLD address that two live rows both hold as their legacyUrn (#697 alias map). */
const ambiguous: Record<string, string> = {};

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
      return Promise.reject(new Error('db down 2975 private-detail'));
    }
    return real(a);
  }) as any);
  return state;
}

/** The single DB read each arm's ref resolver makes first — the one its catch used to swallow. */
const FAULT: Record<string, () => { fired: boolean }> = {
  memory: () => faultOnce('memory', 'findFirst', (a) => typeof a?.where?.urn === 'string'),
  org: () => faultOnce('organization', 'findFirst', (a) => typeof a?.where?.urn === 'string'),
  agent: () => faultOnce('agent', 'findFirst', (a) => typeof a?.where?.urn === 'string'),
  action: () => faultOnce('agent', 'findFirst', (a) => typeof a?.where?.urn === 'string'),
  app: () => faultOnce('app', 'findFirst', (a) => typeof a?.where?.urn === 'string'),
  user: () => faultOnce('user', 'findFirst', (a) => typeof a?.where?.handle === 'string'),
};
const ARMS = Object.keys(FAULT);

beforeAll(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: 'fault org', urn: `fault2975-${s}` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other org', urn: `fault2975-other-${s}` } });
  const owner = await db.user.create({ data: { id: generateId(), handle: `f2975-owner-${s}`, githubUsername: `f2975-owner-${s}`, roles: ['READER'] } });
  const outsider = await db.user.create({ data: { id: generateId(), handle: `f2975-out-${s}`, githubUsername: `f2975-out-${s}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const ownerCtx: Context = { db, userId: owner.id, roles: ['READER'] };
  const created = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Fault Agent' }, ownerCtx);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  const sysMem = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId as string } });
  await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: `register:${CODE}`, name: CODE, content: 'entry' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:fault-mem`, name: 'fault-mem', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const app = await db.app.create({ data: { id: generateId(), name: 'fault-app', urn: `${org.urn}:fault-app`, organizationId: org.id } });

  urn.memory = { mine: `hrn:mem:${memory.urn}`, unknown: `hrn:mem:${org.urn}:no-such-mem` };
  urn.org = { mine: `hrn:org:${org.urn}`, unknown: `hrn:org:no-such-org-${s}` };
  urn.agent = { mine: `hrn:agent:${agent.urn}`, unknown: `hrn:agent:${org.urn}:no-such-agent` };
  urn.action = { mine: `hrn:action:${agent.urn}:${CODE}`, unknown: `hrn:action:${org.urn}:no-such-agent:${CODE}` };
  urn.app = { mine: `hrn:app:${app.urn}`, unknown: `hrn:app:${org.urn}:no-such-app` };
  urn.user = { mine: `hrn:user:${owner.handle}`, unknown: `hrn:user:no-such-user-${s}` };
  // Ambiguous legacy addresses: two live rows of the kind share one legacyUrn.
  const lookup = (u: string) => normalizeUrnForLookup(parseUrnInput(u).value);
  const created2 = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Fault Agent Two' }, ownerCtx);
  const memory2 = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:fault-mem-2`, name: 'fault-mem-2', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const app2 = await db.app.create({ data: { id: generateId(), name: 'fault-app-2', urn: `${org.urn}:fault-app-2`, organizationId: org.id } });
  ambiguous.agent = `hrn:agent:${org.urn}:old-agent`;
  ambiguous.action = `hrn:action:${org.urn}:old-agent:${CODE}`;
  ambiguous.memory = `hrn:mem:${org.urn}:old-mem`;
  ambiguous.app = `hrn:app:${org.urn}:old-app`;
  await db.agent.updateMany({ where: { id: { in: [agent.id, created2.id] } }, data: { legacyUrn: lookup(ambiguous.agent) } });
  await db.memory.updateMany({ where: { id: { in: [memory.id, memory2.id] } }, data: { legacyUrn: lookup(ambiguous.memory) } });
  await db.app.updateMany({ where: { id: { in: [app.id, app2.id] } }, data: { legacyUrn: lookup(ambiguous.app) } });
  // Organization has no legacyUrn column: its aliases live only in the #1079 rename map.
  ambiguous.org = `hrn:org:old-org-${s}`;
  await db.urnAlias.createMany({
    data: [org.id, otherOrg.id].map((entityId) => ({ urn: lookup(ambiguous.org!), entityType: 'ORGANIZATION' as const, entityId, reason: 'RENAME' as const })),
  });

  // Guard against a fixture that never reaches the arm it pins.
  expect(emitNodeUrnV2(sysMem.urn, `register:${CODE}`)).toContain(CODE);

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
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('#2975 resolveUrn: an operational fault inside the ref resolver is a fault, not "not found"', () => {
  it.each(ARMS)('control: the owner resolves the %s fixture with no fault', async (arm) => {
    const r = await gql('owner', urn[arm]!.mine);
    expect(r.errors, arm).toBeUndefined();
    expect(r.data?.resolveUrn, arm).not.toBeNull();
  });

  it.each(ARMS)('%s arm: a DB fault in the ref resolver surfaces the generic internal-fault envelope', async (arm) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = FAULT[arm]!();
    const r = await gql('owner', urn[arm]!.mine);
    expect(probe.fired, `${arm}: the fault was injected`).toBe(true);
    expect(r.data?.resolveUrn ?? null, `${arm}: not answered as not-found`).toBeNull();
    expect(r.errors, `${arm}: an error, not a silent null`).toHaveLength(1);
    const [err] = r.errors!;
    expect(err!.message).toBe('Internal server error.');
    expect(err!.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err!.extensions?.requestId).toMatch(UUID);
    expect(JSON.stringify(r)).not.toContain('private-detail');
  });
});

describe('#2975 resolveUrn: refusals stay byte-identical (names nothing / not yours)', () => {
  it.each(ARMS)('%s arm: an unknown ref answers null with no error', async (arm) => {
    const r = await gql('owner', urn[arm]!.unknown);
    expect(r.errors, arm).toBeUndefined();
    expect(r.data?.resolveUrn, arm).toBeNull();
  });

  // Gate ruling (a) on #2975 (Xanthos, team chat #63349): an ambiguous legacy
  // address keeps today's uniform null on the entity arms. Letting
  // AmbiguousLegacyUrnError escape would hand any caller a typed
  // AMBIGUOUS_LEGACY_URN (formatError maps it), i.e. a new existence signal.
  it.each(['agent', 'action', 'memory', 'app', 'org'])('%s arm: an ambiguous legacy address stays the uniform null', async (arm) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await gql('owner', ambiguous[arm]!);
    expect(r.errors, arm).toBeUndefined();
    expect(r.data?.resolveUrn, arm).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a malformed leaf names nothing: null with no error', async () => {
    for (const u of [
      urn.action!.mine.replace(CODE, 'BAD CODE!'), // charset
      `hrn:action:${urn.agent!.mine.slice('hrn:agent:'.length)}`, // arity: no code
      'hrn:agent:no-root-only', // not fully qualified
      'hrn:org:', // empty
    ]) {
      const r = await gql('owner', u);
      expect(r.errors, u).toBeUndefined();
      expect(r.data?.resolveUrn, u).toBeNull();
    }
  });

  // §10 P2 on #3134 (Rico): a NUL or a lone surrogate passes the urn-lib
  // grammar but Postgres rejects it as a query parameter. With the catches
  // narrowed, that rejection became INTERNAL_SERVER_ERROR (main answered null).
  // Such a ref names nothing: null, no error, no logged fault.
  it.each(ARMS)('%s arm: a ref holding NUL or a lone surrogate names nothing (null, no error, no fault)', async (arm) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = urn[arm]!.mine;
    for (const bad of ['\0', '\uD800', '\uDC00', 'a\uD800b']) {
      for (const u of [`${base}${bad}`, `${base.slice(0, -1)}${bad}${base.slice(-1)}`]) {
        const r = await gql('owner', u);
        expect(r, JSON.stringify(u)).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('Rico probe shapes: NUL / lone surrogate in the root segment answer null with no error', async () => {
    for (const u of ['hrn:mem:a\0b:c', 'hrn:org:a\0b', 'hrn:user:a\0b', 'hrn:user:\uD800x', 'hrn:agent:a\0b:c', 'hrn:app:a\uDC00b:c', 'hrn:action:a\0b:c:d']) {
      const r = await gql('outsider', u);
      expect(r, JSON.stringify(u)).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
    }
  });

  it.each(ARMS.filter((a) => a !== 'user'))('oracle: for an outsider, %s not-yours and unknown are byte-identical', async (arm) => {
    const mine = await gql('outsider', urn[arm]!.mine);
    const unknown = await gql('outsider', urn[arm]!.unknown);
    expect(mine).toEqual(unknown);
    expect(mine).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });

  it('oracle: for an outsider, a user they share no org with and an unknown user are byte-identical', async () => {
    const mine = await gql('outsider', urn.user!.mine);
    const unknown = await gql('outsider', urn.user!.unknown);
    expect(mine).toEqual(unknown);
    expect(mine).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });
});
