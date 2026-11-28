/**
 * #4141 (S5 of #775, third field) — `appRuns(parentRunRef:)`. Contract: the CHECKED comment on #4141 (6882200629).
 * The filter keeps its tri-state (omitted = no filter, null = top-level only, a ref = that run's children), the org
 * READER gate runs first, and a ref that names no run in scope is one exactly-empty page, never an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { generateId } from '../../../lib/id.js';
import { composeAppRunUrn } from '../../../lib/entityRef/appRunRef.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
let orgId: string;
let appId: string;
let appUrn: string;
let app2Id: string;
let app2Urn: string;
let readerId: string;
let parentId: string;
let childId: string;
let otherParentId: string;
let otherChildId: string;

async function exec(query: string, variables: Record<string, unknown>, ctx: Partial<Context>) {
  const out = await server.executeOperation({ query, variables }, { contextValue: { db, roles: [], ...ctx } as Context });
  if (out.body.kind !== 'single') throw new Error('incremental response');
  return out.body.singleResult;
}
const LIST = 'query($app: ID, $org: ID, $p: ID) { appRuns(appRef: $app, orgRef: $org, parentRunRef: $p) { total items { id } } }';
const LIST_ALL = 'query($app: ID) { appRuns(appRef: $app) { total items { id } } }';
const list = (vars: Record<string, unknown>, ctx: Partial<Context> = { roles: ['ADMIN'] }) => exec(LIST, { app: appUrn, ...vars }, ctx);
const ids = (r: { data?: unknown }) => ((r.data as any).appRuns.items as { id: string }[]).map((i) => i.id).sort();
const code = (r: { errors?: readonly { extensions?: Record<string, unknown> }[] }) => r.errors?.[0]?.extensions?.code;

/** The real client with one `appRun` method replaced: the resolver sees a fault or a count, whatever module does the lookup. */
const dbWithAppRun = (over: Record<string, unknown>) =>
  new Proxy(db, {
    get: (t, k) => (k === 'appRun' ? new Proxy(t.appRun, { get: (m, f) => over[f as string] ?? Reflect.get(m, f) }) : Reflect.get(t, k)),
  }) as Context['db'];

async function foreignOrgWithChild() {
  const org = await db.organization.create({ data: { name: 'prr-foreign', urn: 'prr-foreign' } });
  const app = await db.app.create({ data: { organizationId: org.id, urn: 'prr-foreign:app', name: 'F' } });
  const agentId = await testRunAgentId(db, org.id, app.id);
  const run = async (parentRunId: string | null) =>
    (await db.appRun.create({
      data: { id: generateId(), organizationId: org.id, appId: app.id, agentId, triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status: 'RUNNING', parentRunId },
    })).id;
  const parent = await run(null);
  return { parent, child: await run(parent) };
}

async function newRun(forApp: string, parentRunId: string | null = null) {
  return (await db.appRun.create({
    data: { id: generateId(), organizationId: orgId, appId: forApp, agentId: await testRunAgentId(db, orgId, forApp), triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status: 'RUNNING', parentRunId },
  })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'prr4141', urn: 'prr4141' } });
  orgId = org.id;
  const app = await db.app.create({ data: { organizationId: orgId, urn: 'prr4141:app', name: 'App' } });
  appId = app.id;
  appUrn = app.urn;
  const app2 = await db.app.create({ data: { organizationId: orgId, urn: 'prr4141:app2', name: 'App2' } });
  app2Id = app2.id;
  app2Urn = app2.urn;
  const reader = await db.user.create({ data: { email: 'reader-prr4141@example.com', name: 'Reader' } });
  readerId = reader.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: readerId, role: 'READER' } });
  parentId = await newRun(appId);
  childId = await newRun(appId, parentId);
  otherParentId = await newRun(appId);
  otherChildId = await newRun(appId, otherParentId);
});

describe('#4141 appRuns(parentRunRef:)', () => {
  it('omitted is no filter, null is top-level only, a ref is that run\'s children', async () => {
    expect(ids(await list({}))).toEqual([parentId, childId, otherParentId, otherChildId].sort());
    expect(ids(await list({ p: null }))).toEqual([parentId, otherParentId].sort());
    expect(ids(await list({ p: parentId }))).toEqual([childId]);
  });

  it('a canonical URN lists the same children as the PK', async () => {
    const byPk = await list({ p: parentId });
    const byUrn = await list({ p: composeAppRunUrn(appUrn, parentId) });
    expect(byUrn.errors).toBeUndefined();
    expect(ids(byUrn)).toEqual(ids(byPk));
    expect(ids(byUrn)).toEqual([childId]);
  });

  it('a run with no children is an empty page, like an unknown ref', async () => {
    expect(ids(await list({ p: childId }))).toEqual([]);
  });

  it('unknown PK, unknown URN, unknown App URN, an ambiguous legacy App and a foreign-org run give ONE byte-identical empty page', async () => {
    for (const n of ['a', 'b']) await db.app.create({ data: { organizationId: orgId, urn: `prr4141:amb-${n}`, name: n, legacyUrn: 'prr4141:legacy-app' } });
    const { parent: foreignRun } = await foreignOrgWithChild();
    const unknown = generateId();
    const refs = [
      unknown,
      composeAppRunUrn(appUrn, unknown),
      `hrn:apprun:prr4141:no-such-app:${parentId}`,
      `hrn:apprun:prr4141:legacy-app:${parentId}`,
      foreignRun,
      composeAppRunUrn('prr-foreign:app', foreignRun),
    ];
    const answers = [];
    for (const p of refs) answers.push(await list({ p }));
    for (const [i, a] of answers.entries()) {
      expect(a.errors, refs[i]).toBeUndefined();
      expect((a.data as any).appRuns, refs[i]).toEqual({ total: 0, items: [] });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a.data))).size).toBe(1);
  });

  it('a database fault in the run lookup propagates; it is not an empty page', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('boom: connection lost'));
    for (const p of [parentId, composeAppRunUrn(appUrn, parentId)]) {
      const out = await list({ p }, { roles: ['ADMIN'], db: dbWithAppRun({ findUnique: boom, findFirst: boom }) });
      expect(code(out), p).toBe('INTERNAL_SERVER_ERROR');
      expect(out.data, p).toBeNull();
    }
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('a malformed ref and a well-formed wrong-type ref are BAD_USER_INPUT, distinct from a miss', async () => {
    for (const p of ['hrn:apprun:::', 'not a ref', `hrn:node:prr4141:app:${parentId}`]) {
      const out = await list({ p });
      expect(code(out), p).toBe('BAD_USER_INPUT');
    }
  });

  it('a malformed ref reaches no run lookup', async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const counted = dbWithAppRun({ findUnique: lookup, findFirst: lookup, findMany: lookup, count: lookup });
    for (const p of ['hrn:apprun:::', 'not a ref', `hrn:node:prr4141:app:${parentId}`]) {
      expect(code(await list({ p }, { roles: ['ADMIN'], db: counted })), p).toBe('BAD_USER_INPUT');
    }
    expect(lookup).not.toHaveBeenCalled();
    // Control: the same client does see the lookup of a well-shaped ref.
    await list({ p: parentId }, { roles: ['ADMIN'], db: counted });
    expect(lookup).toHaveBeenCalled();
  });

  it('a URN whose App segment is not the run\'s App names nothing, under either App and under the org', async () => {
    const p = composeAppRunUrn(app2Urn, parentId);
    for (const scope of [{ app: appUrn }, { app: app2Urn }, { org: 'prr4141' }]) {
      const out = await exec(LIST, { ...scope, p }, { roles: ['ADMIN'] });
      expect(out.errors).toBeUndefined();
      expect((out.data as any).appRuns).toEqual({ total: 0, items: [] });
    }
  });

  it('composes AND with statuses', async () => {
    const done = await newRun(appId, parentId);
    await db.appRun.update({ where: { id: done }, data: { status: 'COMPLETED' } });
    const q = 'query($app: ID, $p: ID, $s: [AppRunStatus!]) { appRuns(appRef: $app, parentRunRef: $p, statuses: $s) { total items { id } } }';
    const run = async (s: string[]) => ids(await exec(q, { app: appUrn, p: parentId, s }, { roles: ['ADMIN'] }));
    expect(await run(['COMPLETED'])).toEqual([done]);
    expect(await run(['RUNNING'])).toEqual([childId]);
    expect(await run(['RUNNING', 'COMPLETED'])).toEqual([childId, done].sort());
    expect(await run([])).toEqual([]);
  });

  it('composes AND with appRef: a same-org run of another App yields no children under this appRef', async () => {
    const run2 = await newRun(app2Id);
    const child2 = await newRun(app2Id, run2);
    expect(ids(await exec(LIST, { app: app2Urn, p: run2 }, { roles: ['ADMIN'] }))).toEqual([child2]);
    expect(ids(await list({ p: run2 }))).toEqual([]);
  });

  it('works with orgRef alone, across the org\'s Apps', async () => {
    const run2 = await newRun(app2Id);
    const child2 = await newRun(app2Id, run2);
    const out = await exec(LIST, { org: 'prr4141', p: run2 }, { roles: ['ADMIN'] });
    expect(ids(out)).toEqual([child2]);
  });

  // #4995 item 1: with no appRef nothing but `organizationId` scopes the page.
  it('orgRef alone: a foreign-org parent is the exactly-empty page, for an admin and for a member', async () => {
    const { parent, child } = await foreignOrgWithChild();
    for (const ctx of [{ roles: ['ADMIN'] }, { userId: readerId, roles: [] }] as Partial<Context>[]) {
      for (const p of [parent, composeAppRunUrn('prr-foreign:app', parent)]) {
        const out = await exec(LIST, { org: 'prr4141', p }, ctx);
        expect(out.errors).toBeUndefined();
        expect((out.data as any).appRuns).toEqual({ total: 0, items: [] });
      }
    }
    // Control: under its own org the same parent has that child.
    expect(ids(await exec(LIST, { org: 'prr-foreign', p: parent }, { roles: ['ADMIN'] }))).toEqual([child]);
  });

  it('orgRef alone with null lists the own org\'s top-level runs only', async () => {
    await foreignOrgWithChild();
    for (const ctx of [{ roles: ['ADMIN'] }, { userId: readerId, roles: [] }] as Partial<Context>[]) {
      const out = await exec(LIST, { org: 'prr4141', p: null }, ctx);
      expect(ids(out)).toEqual([parentId, otherParentId].sort());
      expect((out.data as any).appRuns.total).toBe(2);
    }
  });

  it('the org READER gate runs first: a non-member is the App NOT_FOUND for a good ref AND for a malformed one', async () => {
    const stranger = await db.user.create({ data: { email: 'stranger-prr4141@example.com', name: 'S' } });
    for (const p of [parentId, 'not a ref', generateId()]) {
      const out = await list({ p }, { userId: stranger.id, roles: [] });
      expect(code(out), p).toBe('NOT_FOUND');
    }
    const member = await list({ p: parentId }, { userId: readerId, roles: [] });
    expect(ids(member)).toEqual([childId]);
  });

  it('the old `parentRunId` argument no longer validates', async () => {
    const out = await exec('query($a: ID, $p: ID) { appRuns(appRef: $a, parentRunId: $p) { total } }', { a: appUrn, p: parentId }, { roles: ['ADMIN'] });
    expect(code(out)).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(out.errors?.[0]?.message).toContain('Unknown argument "parentRunId"');
    expect(await exec(LIST_ALL, { app: appUrn }, { roles: ['ADMIN'] })).toMatchObject({ data: { appRuns: { total: 4 } } });
  });
});
