/**
 * hadron-server#5319: Ticker.owner (an ActorRef) exposes the person owner's handle and a URN.
 *
 * A person is addressed as hrn:user:<handle> (hrn:node:hadronmemory.com:specs:cor:urn:010:01; composed by userUrn in
 * src/lib/userHandle.ts, the single source the User.urn field and the comment projections use). A person with no handle
 * has no hrn:user: address, so both handle and urn are null: the platform never emits a URN that does not resolve.
 * users.handle is NOT NULL today (a DB default fills it), so the handle-less arm is pinned with a stubbed db (pin 3b); the
 * reachable form, a grandfathered handle that is not URN-legal, keeps its handle and reads urn null (pin 3a).
 * A worker arm is unchanged (handle null, urn the hrn:worker: URN). Subscription.createdBy shares the projection, so its
 * person arm gains the same two fields; the worker/agent-only ActorRef fields (createdByWorker, createdByAgent,
 * editedByWorker, editedByAgent) can never be persons and read handle as null.
 *
 * The queries run through the real schema (typeDefs + resolvers), so a missing SDL field fails here, not only in a resolver
 * unit call. handle and urn ride the same projection and the same read gate as id and name: no new gate.
 */
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let n: number;
let org: { id: string; urn: string };
let admin: { id: string };
let legacy: { id: string };
let agentId: string;
let app: { id: string; urn: string };
let ada: { id: string };
let api: ApolloServer<Context>;
let post: ReturnType<typeof vi.spyOn>;

const run = async (query: string, c: Context, variables: Record<string, unknown> = {}) => {
  const r = await api.executeOperation({ query, variables }, { contextValue: c });
  if (r.body.kind !== 'single') throw new Error('unexpected body');
  return r.body.singleResult;
};
const OWNER = `query($r:String!){ ticker(ref:$r){ owner { id name handle urn } } }`;

beforeEach(async () => {
  await cleanDb(db);
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'ar', urn: `ar5319-${n}.example` }, select: { id: true, urn: true } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 53_190_000 + (n % 1000), githubUsername: `ar-admin-${n}`, handle: `ar-admin-${n}`, name: 'Ada Admin', roles: ['READER'] },
    select: { id: true },
  });
  // A grandfathered handle that is not URN-legal (#325 grandfathers such rows): it has no hrn:user: address.
  legacy = await db.user.create({ data: { id: generateId(), githubId: 53_191_000 + (n % 1000), handle: `legacy handle ${n}`, name: 'Legacy', roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: legacy.id, role: 'member' } });
  ada = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: admin.id, heldAt: new Date() },
    select: { id: true },
  });
  api = new ApolloServer<Context>({ typeDefs, resolvers });
  await api.start();
});

afterEach(async () => {
  await api.stop();
  post.mockRestore();
});

const mkTicker = (name: string, c: Context) => M.createTicker({}, { appRef: app.id, input: { name, cadenceSeconds: 600 } }, c);

describe('#5319 Ticker.owner names a person by handle and URN', () => {
  it('pin 1: a person owner reads its handle and hrn:user:<handle> (red on main: no handle field, urn null)', async () => {
    const t = await mkTicker('Person-owned', ctx(admin.id));
    const r = await run(OWNER, ctx(admin.id), { r: t.id });
    expect(r.errors).toBeUndefined();
    expect((r.data as any).ticker.owner).toEqual({ id: admin.id, name: 'Ada Admin', handle: `ar-admin-${n}`, urn: `hrn:user:ar-admin-${n}` });
  });

  it('pin 2: a worker owner is unchanged: handle null, urn the hrn:worker: URN', async () => {
    const t = await runAsActor({ workerId: ada.id, agentId }, () => mkTicker('Worker-owned', ctx(admin.id)));
    const r = await run(OWNER, ctx(admin.id), { r: t.id });
    expect(r.errors).toBeUndefined();
    expect((r.data as any).ticker.owner).toEqual({ id: ada.id, name: 'Ada', handle: null, urn: `hrn:worker:${org.urn}:a:ada` });
  });

  it('pin 3a: a person owner whose handle is not URN-legal keeps the handle and reads urn null, never a URN that does not resolve', async () => {
    const t = await mkTicker('Legacy-owned', ctx(legacy.id));
    const r = await run(OWNER, ctx(admin.id), { r: t.id });
    expect(r.errors).toBeUndefined();
    expect((r.data as any).ticker.owner).toEqual({ id: legacy.id, name: 'Legacy', handle: `legacy handle ${n}`, urn: null });
  });

  it('pin 3b: a person owner with no handle reads null handle and null urn', async () => {
    const stub = { user: { findUnique: async () => ({ id: 'u-none', name: 'No Handle', handle: null }) } };
    const owner = await (resolvers as any).Ticker.owner({ ownerWorkerId: null, ownerUserId: 'u-none' }, {}, { db: stub } as unknown as Context);
    expect(owner).toEqual({ id: 'u-none', name: 'No Handle', handle: null, urn: null });
  });

  it('pin 4: Subscription.createdBy shares the projection: a person creator reads handle and URN, a worker creator handle null', async () => {
    const t = await mkTicker('Subscribed', ctx(admin.id));
    await M.subscribeWorker({}, { tickerRef: t.id, workerRef: ada.id }, ctx(admin.id));
    const r = await run(`query($r:String!){ ticker(ref:$r){ subscribers { items { createdBy { id handle urn } } } } }`, ctx(admin.id), { r: t.id });
    expect(r.errors).toBeUndefined();
    expect((r.data as any).ticker.subscribers.items).toEqual([{ createdBy: { id: admin.id, handle: `ar-admin-${n}`, urn: `hrn:user:ar-admin-${n}` } }]);
  });

  it('pin 5: the read gate is unchanged: an outsider who may not read the ticker gets no owner, handle or URN', async () => {
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 53_192_000 + (n % 1000), handle: `ar-out-${n}`, roles: ['READER'] }, select: { id: true } });
    const t = await mkTicker('Private', ctx(admin.id));
    const asAdmin = await run(OWNER, ctx(admin.id), { r: t.id });
    const asOutsider = await run(OWNER, ctx(outsider.id), { r: t.id });
    expect((asAdmin.data as any).ticker.owner.handle).toBe(`ar-admin-${n}`);
    expect(JSON.stringify(asOutsider)).not.toContain(`ar-admin-${n}`);
    expect((asOutsider.data as any)?.ticker ?? null).toBeNull();
  });
});

describe('#5319 the ActorRef SDL', () => {
  it('pin 6: ActorRef carries a nullable handle and its description names the person arm', async () => {
    const r = await run(`{ __type(name: "ActorRef") { description fields { name type { kind name } } } }`, ctx(admin.id));
    const type = (r.data as any).__type;
    expect(type.fields.find((f: any) => f.name === 'handle')).toEqual({ name: 'handle', type: { kind: 'SCALAR', name: 'String' } });
    expect(type.description).toMatch(/person/i);
  });
});
