/**
 * #4141 (S5 of #775) — `cancelAppRun(ref:)` and `startAgentSession(agentRef:)` take an entity reference (PK or URN).
 * Contract: the CHECKED comment on #4141 (6882200629). Refusals stay byte-identical to today's; a URN reaches the same
 * gates a PK does, and only the RESOLVED id is ever written or compared.
 */
import { AmbiguousLegacyUrnError, AppRunNotFoundError } from '../../../lib/entityRef/errors.js';
import * as agentRefModule from '../../../lib/entityRef/agentRef.js';
import * as appRunRefModule from '../../../lib/entityRef/appRunRef.js';
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
let agentId: string;
let readerId: string;
let runId: string;

async function exec(query: string, variables: Record<string, unknown>, ctx: Partial<Context>) {
  const out = await server.executeOperation({ query, variables }, { contextValue: { db, roles: [], ...ctx } as Context });
  if (out.body.kind !== 'single') throw new Error('incremental response');
  return out.body.singleResult;
}
const CANCEL = 'mutation($r: ID!) { cancelAppRun(ref: $r) { id status } }';
const cancel = (ref: string, ctx: Partial<Context> = { roles: ['ADMIN'] }) => exec(CANCEL, { r: ref }, ctx);
const START = 'mutation($r: ID!) { startAgentSession(agentRef: $r) { id } }';
const start = (ref: string, withApp = true) => exec(START, { r: ref }, withApp ? { appId } : {});
const code = (r: { errors?: readonly { extensions?: Record<string, unknown> }[] }) => r.errors?.[0]?.extensions?.code;
const message = (r: { errors?: readonly { message: string }[] }) => r.errors?.[0]?.message;

async function newRun(status: 'PENDING' | 'RUNNING' = 'RUNNING') {
  return (await db.appRun.create({
    data: { id: generateId(), organizationId: orgId, appId, agentId: await testRunAgentId(db, orgId, appId), triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status },
  })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'refs4141', urn: 'refs4141' } });
  orgId = org.id;
  const agent = await db.agent.create({ data: { organizationId: orgId, urn: 'refs4141:agent', name: 'Agent', type: 'CHATBOT' } });
  agentId = agent.id;
  const app = await db.app.create({ data: { organizationId: orgId, urn: 'refs4141:app', name: 'App' } });
  appId = app.id;
  appUrn = app.urn;
  await db.appAgent.create({ data: { appId, agentId } });
  const reader = await db.user.create({ data: { email: 'reader4141@example.com', name: 'Reader' } });
  readerId = reader.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: readerId, role: 'READER' } });
  runId = await newRun();
});

describe('#4141 cancelAppRun(ref:)', () => {
  it('cancels by PK', async () => {
    const out = await cancel(runId);
    expect(out.errors).toBeUndefined();
    expect((out.data as any).cancelAppRun).toMatchObject({ id: runId, status: 'CANCELLED' });
  });

  it('cancels by canonical URN, writing the resolved id (never the URN)', async () => {
    const out = await cancel(composeAppRunUrn(appUrn, runId));
    expect(out.errors).toBeUndefined();
    expect((out.data as any).cancelAppRun).toMatchObject({ id: runId, status: 'CANCELLED' });
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('CANCELLED');
  });

  it('an unknown PK and an unknown well-shaped URN get the same NOT_FOUND "Run not found."', async () => {
    const unknownId = generateId();
    const byPk = await cancel(unknownId);
    const byUrn = await cancel(composeAppRunUrn(appUrn, unknownId));
    expect(code(byPk)).toBe('NOT_FOUND');
    expect(message(byPk)).toBe('Run not found.');
    expect(code(byUrn)).toBe('NOT_FOUND');
    expect(message(byUrn)).toBe(message(byPk));
  });

  it('a URN naming an unknown App is the same miss', async () => {
    const out = await cancel(`hrn:apprun:refs4141:no-such-app:${runId}`);
    expect(code(out)).toBe('NOT_FOUND');
    expect(message(out)).toBe('Run not found.');
  });

  it('a non-admin keeps FORBIDDEN, identical for a PK and a URN, and the run is untouched', async () => {
    const ctx = { userId: readerId, roles: [] as Context['roles'] };
    const byPk = await cancel(runId, ctx);
    const byUrn = await cancel(composeAppRunUrn(appUrn, runId), ctx);
    expect(code(byPk)).toBe('FORBIDDEN');
    expect(code(byUrn)).toBe('FORBIDDEN');
    expect(message(byUrn)).toBe(message(byPk));
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('RUNNING');
  });

  it('a malformed URN and a well-formed wrong-type URN are shape errors (BAD_USER_INPUT), distinct from a miss', async () => {
    for (const ref of ['hrn:apprun:::', 'not a ref', `hrn:node:refs4141:app:${runId}`]) {
      const out = await cancel(ref);
      expect(code(out), ref).toBe('BAD_USER_INPUT');
    }
  });

  it('cancelling a terminal run is the same no-op return', async () => {
    const done = await newRun();
    await db.appRun.update({ where: { id: done }, data: { status: 'COMPLETED' } });
    const out = await cancel(composeAppRunUrn(appUrn, done));
    expect(out.errors).toBeUndefined();
    expect((out.data as any).cancelAppRun.status).toBe('COMPLETED');
  });

  it('the old `id` argument no longer validates', async () => {
    const out = await exec('mutation($i: ID!) { cancelAppRun(id: $i) { id } }', { i: runId }, { roles: ['ADMIN'] });
    expect(out.errors?.length).toBeGreaterThan(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('RUNNING');
  });

  it('an ambiguous legacy ref (two live holders) is byte-identical to an unknown ref, and the run is untouched', async () => {
    const apps = await Promise.all(['a', 'b'].map((n) => db.app.create({ data: { organizationId: orgId, urn: `refs4141:amb-${n}`, name: n, legacyUrn: 'refs4141:legacy-app' } })));
    expect(apps.length).toBe(2);
    const unknown = await cancel(`hrn:apprun:refs4141:no-such-app:${runId}`);
    const ambiguous = await cancel(`hrn:apprun:refs4141:legacy-app:${runId}`);
    expect(code(ambiguous)).toBe('NOT_FOUND');
    expect(JSON.stringify(ambiguous.errors)).toBe(JSON.stringify(unknown.errors));
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('RUNNING');
  });

  it('a resolver that throws AmbiguousLegacyUrnError folds to the same NOT_FOUND', async () => {
    const spy = vi.spyOn(appRunRefModule, 'resolveAppRunRef').mockRejectedValueOnce(new AmbiguousLegacyUrnError('x', ['a', 'b']));
    try {
      const out = await cancel(composeAppRunUrn(appUrn, runId));
      expect(code(out)).toBe('NOT_FOUND');
      expect(message(out)).toBe('Run not found.');
    } finally {
      spy.mockRestore();
    }
  });

  it('a database fault inside the resolver propagates, the run stays RUNNING', async () => {
    const spy = vi.spyOn(appRunRefModule, 'resolveAppRunRef').mockRejectedValueOnce(new Error('boom: connection lost'));
    try {
      const out = await cancel(composeAppRunUrn(appUrn, runId));
      expect(code(out)).toBe('INTERNAL_SERVER_ERROR');
      expect(message(out)).not.toBe('Run not found.');
    } finally {
      spy.mockRestore();
    }
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('RUNNING');
  });

  it('a URN whose App segment names another App than the run is NOT_FOUND and cancels nothing', async () => {
    const other = await db.app.create({ data: { organizationId: orgId, urn: 'refs4141:other-app', name: 'Other' } });
    const out = await cancel(composeAppRunUrn(other.urn, runId));
    expect(code(out)).toBe('NOT_FOUND');
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('RUNNING');
  });

  it('a database fault while resolving propagates; it is not a "Run not found."', async () => {
    const spy = vi.spyOn(db.appRun, 'findUnique').mockRejectedValueOnce(new Error('boom: connection lost'));
    try {
      const out = await cancel(runId);
      expect(code(out)).not.toBe('NOT_FOUND');
      expect(message(out)).not.toBe('Run not found.');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('#4141 startAgentSession(agentRef:)', () => {
  it('starts a session by PK and by URN', async () => {
    for (const ref of [agentId, 'hrn:agent:refs4141:agent']) {
      const out = await start(ref);
      expect(out.errors, ref).toBeUndefined();
      const session = await db.session.findUniqueOrThrow({ where: { id: (out.data as any).startAgentSession.id } });
      expect(session.agentId).toBe(agentId);
    }
  });

  it('unknown PK, unknown URN, an uninstalled Agent and a soft-deleted Agent answer with ONE byte-identical refusal', async () => {
    const other = await db.agent.create({ data: { organizationId: orgId, urn: 'refs4141:other', name: 'Other', type: 'CHATBOT' } });
    const gone = await db.agent.create({ data: { organizationId: orgId, urn: 'refs4141:gone', name: 'Gone', type: 'CHATBOT', deletedAt: new Date() } });
    await db.appAgent.create({ data: { appId, agentId: gone.id } });
    const refs = [generateId(), 'hrn:agent:refs4141:nobody', other.id, 'hrn:agent:refs4141:other', gone.id, 'hrn:agent:refs4141:gone'];
    const answers = [];
    for (const ref of refs) answers.push(await start(ref));
    for (const a of answers) {
      expect(code(a)).toBe('FORBIDDEN');
      expect(message(a)).toBe('Forbidden: App is not allowed to operate this agent');
    }
    expect(JSON.stringify(answers.map((a) => a.errors))).not.toContain(other.id);
  });

  it('writes no session, memory, user or subscription row on any refusal', async () => {
    const snap = async () => ({
      sessions: await db.session.count(), memories: await db.memory.count(), users: await db.user.count(), subs: await db.agentSubscription.count(),
    });
    const before = await snap();
    await start(generateId());
    await start('hrn:agent:refs4141:nobody');
    expect(await snap()).toEqual(before);
  });

  it('a relative URN is a shape refusal, after the App-key gate', async () => {
    const out = await start('agent');
    expect(code(out)).toBe('URN_NOT_QUALIFIED');
    expect(out.errors?.length).toBe(1);
    const noKey = await start('agent', false);
    expect(message(noKey)).toBe('Forbidden: App Key required');
  });

  it('a malformed or wrong-type ref is the unqualified-URN shape refusal, never the install refusal or a write', async () => {
    const before = await db.session.count();
    for (const ref of ['hrn:agent:::', 'not a ref', `hrn:node:refs4141:agent:${agentId}`]) {
      const out = await start(ref);
      expect(code(out), ref).toBe('URN_NOT_QUALIFIED');
      expect(out.errors?.length, ref).toBe(1);
    }
    expect(await db.session.count()).toBe(before);
  });

  it('an ambiguous legacy ref is the same refusal as an unknown ref, and writes no session', async () => {
    for (const n of ['a', 'b']) await db.agent.create({ data: { organizationId: orgId, urn: `refs4141:amb-${n}`, name: n, type: 'CHATBOT', legacyUrn: 'refs4141:legacy-agent' } });
    const unknown = await start('hrn:agent:refs4141:nobody');
    const before = await db.session.count();
    const ambiguous = await start('hrn:agent:refs4141:legacy-agent');
    expect(code(ambiguous)).toBe('FORBIDDEN');
    expect(JSON.stringify(ambiguous.errors)).toBe(JSON.stringify(unknown.errors));
    expect(await db.session.count()).toBe(before);
  });

  it('a resolver that throws AmbiguousLegacyUrnError folds to the install refusal', async () => {
    const spy = vi.spyOn(agentRefModule, 'resolveAgentRef').mockRejectedValueOnce(new AmbiguousLegacyUrnError('x', ['a', 'b']));
    try {
      const out = await start(agentId);
      expect(code(out)).toBe('FORBIDDEN');
      expect(message(out)).toBe('Forbidden: App is not allowed to operate this agent');
    } finally {
      spy.mockRestore();
    }
  });

  it('a database fault inside the resolver propagates, and no session is written', async () => {
    const before = await db.session.count();
    const spy = vi.spyOn(agentRefModule, 'resolveAgentRef').mockRejectedValueOnce(new Error('boom: connection lost'));
    try {
      const out = await start(agentId);
      expect(code(out)).toBe('INTERNAL_SERVER_ERROR');
      expect(message(out)).not.toBe('Forbidden: App is not allowed to operate this agent');
    } finally {
      spy.mockRestore();
    }
    expect(await db.session.count()).toBe(before);
  });

  it('the missing App-key gate is unchanged for a valid ref', async () => {
    const out = await start(agentId, false);
    expect(code(out)).toBe('FORBIDDEN');
    expect(message(out)).toBe('Forbidden: App Key required');
  });

  it('the old `agentId` argument no longer validates', async () => {
    const out = await exec('mutation($a: ID!) { startAgentSession(agentId: $a) { id } }', { a: agentId }, { appId });
    expect(out.errors?.length).toBeGreaterThan(0);
  });
});
