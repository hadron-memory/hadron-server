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
import { AmbiguousLegacyUrnError } from '../../../lib/entityRef/errors.js';
import * as appRunRefModule from '../../../lib/entityRef/appRunRef.js';
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
let topId: string;

async function exec(query: string, variables: Record<string, unknown>, ctx: Partial<Context>) {
  const out = await server.executeOperation({ query, variables }, { contextValue: { db, roles: [], ...ctx } as Context });
  if (out.body.kind !== 'single') throw new Error('incremental response');
  return out.body.singleResult;
}
const LIST = 'query($app: String, $org: String, $p: ID) { appRuns(appRef: $app, orgRef: $org, parentRunRef: $p) { total items { id } } }';
const LIST_ALL = 'query($app: String) { appRuns(appRef: $app) { total items { id } } }';
const list = (vars: Record<string, unknown>, ctx: Partial<Context> = { roles: ['ADMIN'] }) => exec(LIST, { app: appUrn, ...vars }, ctx);
const ids = (r: { data?: unknown }) => ((r.data as any).appRuns.items as { id: string }[]).map((i) => i.id).sort();
const code = (r: { errors?: readonly { extensions?: Record<string, unknown> }[] }) => r.errors?.[0]?.extensions?.code;

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
  topId = parentId;
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
    const foreignOrg = await db.organization.create({ data: { name: 'prr-foreign', urn: 'prr-foreign' } });
    const foreignApp = await db.app.create({ data: { organizationId: foreignOrg.id, urn: 'prr-foreign:app', name: 'F' } });
    const foreignRun = (await db.appRun.create({
      data: { id: generateId(), organizationId: foreignOrg.id, appId: foreignApp.id, agentId: await testRunAgentId(db, foreignOrg.id, foreignApp.id), triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status: 'RUNNING' },
    })).id;
    await db.appRun.create({
      data: { id: generateId(), organizationId: foreignOrg.id, appId: foreignApp.id, agentId: await testRunAgentId(db, foreignOrg.id, foreignApp.id), triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status: 'RUNNING', parentRunId: foreignRun },
    });
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

  it('a resolver that throws AmbiguousLegacyUrnError folds to the same empty page', async () => {
    const spy = vi.spyOn(appRunRefModule, 'resolveAppRunRef').mockRejectedValueOnce(new AmbiguousLegacyUrnError('x', ['a', 'b']));
    try {
      const out = await list({ p: composeAppRunUrn(appUrn, parentId) });
      expect((out.data as any).appRuns).toEqual({ total: 0, items: [] });
    } finally {
      spy.mockRestore();
    }
  });

  it('a database fault inside the resolver propagates; it is not an empty page', async () => {
    const spy = vi.spyOn(appRunRefModule, 'resolveAppRunRef').mockRejectedValueOnce(new Error('boom: connection lost'));
    try {
      const out = await list({ p: composeAppRunUrn(appUrn, parentId) });
      expect(code(out)).toBe('INTERNAL_SERVER_ERROR');
      expect(out.data).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('a malformed ref and a well-formed wrong-type ref are BAD_USER_INPUT, distinct from a miss', async () => {
    for (const p of ['hrn:apprun:::', 'not a ref', `hrn:node:prr4141:app:${parentId}`]) {
      const out = await list({ p });
      expect(code(out), p).toBe('BAD_USER_INPUT');
    }
  });

  it('composes AND with appRef: a same-org run of another App yields no children under this appRef', async () => {
    const run2 = await newRun(app2Id);
    const child2 = await newRun(app2Id, run2);
    expect(ids(await exec(LIST, { app: app2Urn, p: run2 }, { roles: ['ADMIN'] }))).toEqual([child2]);
    expect(ids(await list({ p: run2 }))).toEqual([]);
    expect(topId).toBe(parentId);
  });

  it('works with orgRef alone, across the org\'s Apps', async () => {
    const run2 = await newRun(app2Id);
    const child2 = await newRun(app2Id, run2);
    const out = await exec(LIST, { org: 'prr4141', p: run2 }, { roles: ['ADMIN'] });
    expect(ids(out)).toEqual([child2]);
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
    const out = await exec('query($a: String, $p: ID) { appRuns(appRef: $a, parentRunId: $p) { total } }', { a: appUrn, p: parentId }, { roles: ['ADMIN'] });
    expect(out.errors?.length).toBeGreaterThan(0);
    expect(await exec(LIST_ALL, { app: appUrn }, { roles: ['ADMIN'] })).toMatchObject({ data: { appRuns: { total: 4 } } });
  });
});
