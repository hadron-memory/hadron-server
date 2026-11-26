import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #5163 — `ResumeSessionInput.expectedWorkerId` becomes `expectedWorkerRef` (cor:api:140:00, cor:api:140:01; the
 * compare-and-set guard of cor:agt:020:03). Gate (change manager, CHECKED): the id path is byte-preserved (blank is
 * still BAD_USER_INPUT); a fully qualified worker URN resolves through `resolveWorkerRef`; an unknown and an
 * unreadable worker get the SAME refusal (no existence oracle), and a worker the caller holds nothing of follows
 * today's mismatch / nothing-to-resume path; a malformed URN is refused at the boundary; a raw database error never
 * becomes a refusal; naming a worker other than the one waiting refuses WORKER_MISMATCH truthfully. The old field
 * name is gone from the SDL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError, buildSchema, type GraphQLInputObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());
afterEach(() => vi.restoreAllMocks());

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return e as GraphQLError;
  }
  throw new Error('expected a refusal');
}
const envelope = async (p: Promise<unknown>) => {
  const g = await refusal(p);
  return JSON.stringify({ message: g.message, extensions: g.extensions });
};

/** The wire answer, through the published schema and the shared error boundary. */
async function wire(input: string, c: Context, variables?: Record<string, unknown>) {
  const res = await server.executeOperation(
    { query: `mutation($e: ID) { resumeSession(input: ${input}) { outcome session { id workerId } } }`, variables },
    { contextValue: c },
  );
  const body = res.body.kind === 'single' ? res.body.singleResult : null;
  return { data: body?.data, errors: body?.errors ?? [] };
}

let n: number;
let app: { id: string; urn: string };
let foreignApp: { id: string; urn: string };
let holder: string;
let other: string;
let agentId: string;
let ada: string;
let bea: string;
let zed: string;

const start = (userId: string, workerRef: string, plan = 'work') =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef, plan } }, ctx(userId));
const claim = (userId: string, sessionId: string) => M.createResumeClaim({}, { sessionId }, ctx(userId));
const resume = (c: Context, input?: Record<string, unknown>) => M.resumeSession({}, { input: input ?? null }, c);
const nothingEnvelope = () => envelope(resume(ctx(generateId())));
const urnOf = (a: { urn: string }, slug: string) => composeWorkerUrn(a.urn, slug);

async function footprint() {
  return {
    sessions: await db.session.findMany({ orderBy: { id: 'asc' }, select: { id: true, endedAt: true, updatedAt: true, workerId: true } }),
    claims: await db.resumeClaim.findMany({ orderBy: { id: 'asc' }, select: { id: true, consumedAt: true, revokedAt: true, resumedSessionId: true } }),
    holds: await db.worker.findMany({ orderBy: { id: 'asc' }, select: { id: true, heldByUserId: true } }),
  };
}

async function beaClaimOnly() {
  const b = await start(holder, bea, 'bea work');
  await claim(holder, b.id);
  return b;
}

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `r5163-${name}-${n}`, roles: ['READER'] }, select: { id: true } }).then((r) => r.id);
  const admin = await u(71, 'admin');
  holder = await u(72, 'holder');
  other = await u(73, 'other');
  const org = await db.organization.create({ data: { name: 'Tenant', urn: `r5163-${n}.example` }, select: { id: true, urn: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: other, role: 'member' } });
  const w = (appId: string, name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase() }, select: { id: true } }).then((r) => r.id);
  ada = await w(app.id, 'Ada');
  bea = await w(app.id, 'Bea');
  // A worker in another tenant's App: it exists, and the holder may not read it.
  const foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: `f5163-${n}.example` }, select: { id: true, urn: true } });
  foreignApp = await db.app.create({ data: { organizationId: foreignOrg.id, name: 'Elsewhere', urn: `${foreignOrg.urn}:elsewhere` }, select: { id: true, urn: true } });
  zed = await w(foreignApp.id, 'Zed');
  await serveEveryAgent(db);
});

describe('#5163 SDL: the input field is expectedWorkerRef', () => {
  it('ResumeSessionInput declares expectedWorkerRef: ID and no expectedWorkerId', () => {
    const t = buildSchema(typeDefs).getType('ResumeSessionInput') as GraphQLInputObjectType;
    const f = t.getFields();
    expect(f.expectedWorkerRef?.type.toString()).toBe('ID');
    expect(f.expectedWorkerId).toBeUndefined();
  });

  it('the description cites the reference contract fully qualified', () => {
    const t = buildSchema(typeDefs).getType('ResumeSessionInput') as GraphQLInputObjectType;
    expect(t.getFields().expectedWorkerRef?.description).toContain('hrn:node:hadronmemory.com:specs:cor:api:140:01');
  });

  it('the old field name is refused by the schema as a whole, before the resolver runs', async () => {
    const a = await start(holder, ada);
    await claim(holder, a.id);
    const before = await footprint();
    const r = await wire('{ expectedWorkerId: $e }', ctx(holder), { e: ada });
    expect(r.errors[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(r.data).toBeUndefined();
    expect(await footprint()).toEqual(before);
  });
});

describe('#5163 the reference resolves: an id and a worker URN', () => {
  it.each([['an id', () => ada], ['a worker URN', () => urnOf(app, 'ada')], ['a padded URN', () => `  ${urnOf(app, 'ada')}  `]])(
    '%s binds the expected worker while another worker\'s claim waits too',
    async (_label, ref) => {
      const a = await start(holder, ada);
      await claim(holder, a.id);
      await beaClaimOnly();
      expect(await resume(ctx(holder), { expectedWorkerRef: ref() })).toMatchObject({ outcome: 'RESUMED', session: { id: a.id } });
    },
  );

  it('through the published schema, a URN binds the expected worker', async () => {
    const a = await start(holder, ada);
    await claim(holder, a.id);
    await beaClaimOnly();
    const r = await wire('{ expectedWorkerRef: $e }', ctx(holder), { e: urnOf(app, 'ada') });
    expect(r.errors).toEqual([]);
    expect(r.data?.resumeSession).toMatchObject({ outcome: 'RESUMED', session: { id: a.id, workerId: ada } });
  });

  it('compare-and-set: a readable URN naming another worker than the one waiting refuses WORKER_MISMATCH truthfully, before any write', async () => {
    await beaClaimOnly();
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerRef: urnOf(app, 'ada') }));
    expect(g.extensions).toMatchObject({
      code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', picked: false,
      expectedWorkerId: ada, expectedWorkerName: 'Ada', foundWorkerId: bea, foundWorkerName: 'Bea', foundSource: 'CLAIM',
    });
    expect(await footprint()).toEqual(before);
  });

  it('the id path is byte-preserved: the refusal for an id equals the refusal for that worker\'s URN', async () => {
    await beaClaimOnly();
    const byId = await envelope(resume(ctx(holder), { expectedWorkerRef: ada }));
    const byUrn = await envelope(resume(ctx(holder), { expectedWorkerRef: urnOf(app, 'ada') }));
    expect(byUrn).toBe(byId);
  });

  it('a blank ref is still BAD_USER_INPUT before any read, and only for a real caller', async () => {
    const none = await nothingEnvelope();
    await beaClaimOnly();
    const before = await footprint();
    expect((await refusal(resume(ctx(holder), { expectedWorkerRef: '  ' }))).extensions.code).toBe('BAD_USER_INPUT');
    expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context, { expectedWorkerRef: '' }))).toBe(none);
    expect(await footprint()).toEqual(before);
  });
});

describe('#5163 uniform refusal: unknown and unreadable are one answer (no existence oracle)', () => {
  /** Refs that name nothing the holder can see: unknown App, unknown worker slug, a foreign tenant's real worker. */
  const unseen = () => [
    urnOf({ urn: `nowhere-${n}.example:team` }, 'ada'),
    urnOf(app, 'nobody'),
    urnOf(foreignApp, 'zed'),
  ];

  it('with another worker\'s claim waiting: every unseen ref gets the byte-identical WORKER_MISMATCH, naming no id and no ref', async () => {
    await beaClaimOnly();
    const before = await footprint();
    const answers = [];
    for (const ref of unseen()) answers.push(await envelope(resume(ctx(holder), { expectedWorkerRef: ref })));
    expect(new Set(answers).size).toBe(1);
    const g = JSON.parse(answers[0]!);
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', expectedWorkerId: null, expectedWorkerName: null, foundWorkerId: bea });
    expect(answers[0]).not.toContain(zed);
    expect(answers[0]).not.toContain('Zed');
    expect(answers[0]).not.toContain('hrn:worker');
    expect(await footprint()).toEqual(before);
  });

  it('a pick of the caller\'s own other-worker claim: every unseen ref gets the same picked mismatch', async () => {
    const b = await beaClaimOnly();
    const answers = [];
    for (const ref of unseen()) answers.push(await envelope(resume(ctx(holder), { expectedWorkerRef: ref, session: b.id })));
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!).extensions).toMatchObject({ reason: 'WORKER_MISMATCH', picked: true, expectedWorkerId: null });
  });

  it('a readable worker URN the caller holds nothing of, after the caller left its App, answers as the unknown ref does', async () => {
    await beaClaimOnly();
    const unknown = await envelope(resume(ctx(holder), { expectedWorkerRef: urnOf(app, 'nobody') }));
    await db.appMember.deleteMany({ where: { appId: app.id, userId: holder } });
    expect(await envelope(resume(ctx(holder), { expectedWorkerRef: urnOf(app, 'ada') }))).toBe(unknown);
  });

  it('nothing of the caller\'s waits: every unseen ref answers today\'s NOTHING_TO_RESUME byte for byte', async () => {
    const none = await nothingEnvelope();
    const o = await start(other, bea);
    await claim(other, o.id);
    for (const ref of [...unseen(), urnOf(app, 'ada')]) {
      expect(await envelope(resume(ctx(holder), { expectedWorkerRef: ref }))).toBe(none);
    }
  });

  it('a legacy App URN held by two Apps names nothing: the same refusal, never the ambiguity', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: `r5163-${n}.example` }, select: { id: true, urn: true } });
    const legacy = `${org.urn}:oldteam`;
    await db.app.create({ data: { organizationId: org.id, name: 'One', urn: `${org.urn}:one`, legacyUrn: legacy } });
    await db.app.create({ data: { organizationId: org.id, name: 'Two', urn: `${org.urn}:two`, legacyUrn: legacy } });
    await beaClaimOnly();
    const unknown = await envelope(resume(ctx(holder), { expectedWorkerRef: urnOf(app, 'nobody') }));
    expect(await envelope(resume(ctx(holder), { expectedWorkerRef: urnOf({ urn: legacy }, 'ada') }))).toBe(unknown);
  });

  it('a raw database error while resolving propagates: it never becomes a refusal', async () => {
    await beaClaimOnly();
    const before = await footprint();
    vi.spyOn(db.app, 'findFirst').mockRejectedValueOnce(new Error('connection reset 5163'));
    await expect(resume(ctx(holder), { expectedWorkerRef: urnOf(app, 'ada') })).rejects.toThrow('connection reset 5163');
    expect(await footprint()).toEqual(before);
  });
});

describe('#5163 a malformed ref is refused at the boundary', () => {
  it.each([
    ['a name', 'Ada'],
    ['a relative URN', 'team:ada'],
    ['an App URN (wrong type)', 'hrn:app:r5163.example:team'],
    ['a worker URN of the wrong arity', 'hrn:worker:r5163.example:team'],
    ['a short hex', 'abc123'],
    ['a NUL', 'hrn:worker:r5163.example:team:a\u0000da'],
  ])('%s: URN_NOT_QUALIFIED through the wire, no echo, before any read or write', async (_label, bad) => {
    await beaClaimOnly();
    const before = await footprint();
    const r = await wire('{ expectedWorkerRef: $e }', ctx(holder), { e: bad });
    expect(r.errors[0]?.extensions?.code).toBe('URN_NOT_QUALIFIED');
    const text = JSON.stringify(r.errors);
    expect(text).not.toContain(bad.trim());
    expect(text).not.toContain('Bea');
    expect(await footprint()).toEqual(before);
  });

  it('resolve order: an App key or an impersonation sending a malformed ref learns nothing (NOTHING_TO_RESUME first)', async () => {
    const none = await nothingEnvelope();
    expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context, { expectedWorkerRef: 'Ada' }))).toBe(none);
    expect(await envelope(resume({ ...ctx(other), impersonation: { actorUserId: holder } } as unknown as Context, { expectedWorkerRef: urnOf(app, 'ada') }))).toBe(none);
  });
});
