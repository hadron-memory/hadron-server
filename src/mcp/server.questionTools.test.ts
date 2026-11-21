/**
 * #4430 (Questions S6, epic #1641; spec cor:dmo:140:09, :05, :03) — the question tools on the MCP surface.
 *
 * The rules are pinned in the resolver tests (resolvers.questions*.test.ts); this covers the SURFACE: the eight tools
 * call the same resolvers GraphQL serves, refusals come back as `[lower_snake_code] message`, the actor is the session
 * binding (a worker asks as that worker; an agent never answers), the answer surface is recorded as MCP without being an
 * argument, the asker's pull works, the generic node door names the question tool, and MCP offers no approval.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../test/helpers.js';
import { createServerOnCleanDb } from '../test/startServerFixture.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { generateId } from '../lib/id.js';
import { runAsActor } from '../lib/requestActor.js';
import { questionDataSchema } from '../lib/questions/codec.js';
import { mintUserApiKey, type AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const WORKER = 'worker-q4430';
let org: { id: string };
let admin: { id: string };
let holder: { id: string };
let reader: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let logId: string;

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const authOf = (userId: string, extra: Partial<AuthContext> = {}) =>
  ({ userId, roles: ['READER'], clientId: `user:${userId}`, organizationId: org.id, ...extra }) as AuthContext;
const mcp = (userId: string, extra: Partial<AuthContext> = {}) =>
  createTestableMcpServer(authOf(userId, extra), { sessionId: `q-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const gqlCtx = (userId: string): Context => ({ db, userId, roles: [] });
/** The holder's worker session, as the MCP request handler publishes it from a validated binding. */
const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId: WORKER, agentId: null, userId: holder.id }, fn);
const code = (text: string) => /^\[([a-z_]+)\]/.exec(text)?.[1] ?? 'NO_ERROR';
const urnOf = (text: string) => /(hrn:node:\S+:questions:Q\w+)/.exec(text)?.[1];
const revOf = (text: string) => Number(/revision (\d+)/.exec(text)?.[1]);
const ASK = {
  title: 'Ship the codec now?',
  options: [
    { key: 'ship', label: 'Ship it', whyChoose: 'It is ready', whyNot: 'One more review', risks: 'A late bug' },
    { key: 'wait', label: 'Wait a week' },
  ],
  recommendation: { key: 'ship', reason: 'The tests pass' },
};
const dataOf = async (urn: string) => {
  const loc = urn.slice(urn.indexOf(':questions:') + 1);
  const row = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc } });
  return { row, data: questionDataSchema.parse(row.data) };
};

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Question MCP', urn: 'qmcp.example' } });
  admin = await db.user.create({ data: { githubId: 443001, githubUsername: 'q-admin', handle: 'q-admin', roles: [] } });
  holder = await db.user.create({ data: { githubId: 443002, githubUsername: 'q-holder', handle: 'q-holder', roles: [] } });
  reader = await db.user.create({ data: { githubId: 443003, githubUsername: 'q-reader', handle: 'q-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 443004, githubUsername: 'q-outsider', handle: 'q-outsider', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'team-shared' }, gqlCtx(admin.id));
  // The worker's holder is the log's decider: the case the "an agent never answers" rule exists for.
  logId = (await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [holder.id] }, gqlCtx(admin.id))).row.id;
  await createDbWorkerAttribution(db, holder.id, WORKER);
});

async function workerAsks(input: Record<string, unknown> = ASK): Promise<{ text: string; urn: string }> {
  const text = await asWorker(() => mcp(holder.id).callToolText('hadron_ask_question', { logRef: logId, ...input }));
  expect(code(text), text).toBe('NO_ERROR');
  return { text, urn: urnOf(text)! };
}

describe('#4430 ask and read', () => {
  it('a worker session asks: the code and the link come back, askedBy is the worker, get shows OPEN and both options', async () => {
    const { text, urn } = await workerAsks();
    expect(text).toMatch(/Asked Q\w+/);
    expect(text).toContain(urn);
    expect(text).toContain('Give this link to the person who should answer; nothing is sent to them.');
    const { data } = await dataOf(urn);
    expect(data.askedBy.workerId).toBe(WORKER);
    const got = await mcp(holder.id).callToolText('hadron_get_question', { ref: urn });
    expect(got).toContain('State: OPEN');
    expect(got).toContain('ship: Ship it');
    expect(got).toContain('wait: Wait a week');
    expect(got).toContain('Recommendation: ship');
  });

  it('get by code with logRef reads the same question; an unreadable question is not found with no detail', async () => {
    const { urn } = await workerAsks();
    const qcode = /:questions:(Q\w+)/.exec(urn)![1];
    expect(await mcp(holder.id).callToolText('hadron_get_question', { code: qcode, logRef: logId })).toContain(urn);
    const hidden = await mcp(outsider.id).callToolText('hadron_get_question', { ref: urn });
    expect(hidden).toMatch(/^\[question_not_found\] /);
    expect(hidden).not.toContain('Ship');
    // A failed lookup is a failed call (isError), and a missing question reads exactly like an unreadable one (Baloo, Beckett P2).
    const unreadable = await mcp(outsider.id).callTool('hadron_get_question', { ref: urn }) as { isError?: boolean; content: Array<{ text: string }> };
    const missing = await mcp(holder.id).callTool('hadron_get_question', { ref: generateId() }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(unreadable.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe(unreadable.content[0].text);
  });

  it('list_question_logs names the log, and says how to get one when there is none', async () => {
    const logs = await mcp(holder.id).callToolText('hadron_list_question_logs', { memoryRef: memory.id });
    expect(logs).toContain(':questions');
    const other = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'empty' }, gqlCtx(admin.id));
    const none = await mcp(holder.id).callToolText('hadron_list_question_logs', { memoryRef: other.id });
    expect(none).toContain('no question log yet');
  });
});

describe('#4430 the read carries every decision field (Baloo P2)', () => {
  it('authorizes, neededBy, defaultAction, deciders and the reference lists round-trip into hadron_get_question', async () => {
    const neededBy = '2026-12-01T12:00:00.000Z';
    const { urn } = await workerAsks({
      ...ASK, tier: 'SIGNED', authorizes: true, neededBy, defaultAction: 'We wait a week',
      blocks: [{ node: 'hrn:node:qmcp.example:team-shared:plan' }], sources: [{ ref: 'https://example.test/thread' }],
      specsTouched: [{ spec: 'cor:dmo:140:09' }], specsMustChange: [{ spec: 'cor:dmo:140:05' }],
    });
    const got = await mcp(holder.id).callToolText('hadron_get_question', { ref: urn });
    expect(got).toContain('Authorizes: yes');
    expect(got).toContain(`Needed by: ${neededBy}`);
    expect(got).toContain('If no answer in time: We wait a week');
    expect(got).toContain('Deciders: user hrn:user:q-holder');
    expect(got).toContain('Blocks: hrn:node:qmcp.example:team-shared:plan');
    expect(got).toContain('Sources: https://example.test/thread');
    expect(got).toContain('Specs touched: cor:dmo:140:09');
    expect(got).toContain('Specs that must change: cor:dmo:140:05');
  });
});

describe('#4430 amend: null clears the fields the resolver clears (Baloo note)', () => {
  it('background null clears it; the shape accepts null for exactly the five clearable fields', async () => {
    const { text, urn } = await workerAsks({ ...ASK, background: 'Some context', neededBy: '2026-12-01T12:00:00.000Z', defaultAction: 'Wait' });
    const amended = await asWorker(() => mcp(holder.id).callToolText('hadron_amend_question', { ref: urn, expectedRevision: revOf(text), reason: 'clear', background: null }));
    expect(code(amended), amended).toBe('NO_ERROR');
    expect((await dataOf(urn)).data.background).toBeNull();
    expect((await dataOf(urn)).data.defaultAction).toBe('Wait');
    const s = mcp(holder.id);
    for (const k of ['background', 'whyNow', 'neededBy', 'defaultAction', 'assignee']) expect(() => s.toolParamSchema('hadron_amend_question', k).parse(null)).not.toThrow();
    for (const k of ['title', 'priority', 'options']) expect(() => s.toolParamSchema('hadron_amend_question', k).parse(null)).toThrow();
  });

  it('a non-null title amended through MCP is the stored title on the next read (Beckett P2 on #4644)', async () => {
    const { text, urn } = await workerAsks({ ...ASK, background: 'Kept context' });
    const amended = await asWorker(() => mcp(holder.id).callToolText('hadron_amend_question', { ref: urn, expectedRevision: revOf(text), reason: 'reword', title: 'Ship it now?' }));
    expect(code(amended), amended).toBe('NO_ERROR');
    const stored = (await dataOf(urn)).data;
    expect(stored.title).toBe('Ship it now?');
    expect(stored.title).not.toBe(ASK.title);
    expect(stored.background).toBe('Kept context'); // an omitted field is untouched
  });
});

describe('#4430 refusals keep the resolver\'s code and write nothing', () => {
  it('a reader asking, a missing recommendation, a non-decider assignee, a stale amend', async () => {
    const before = await db.node.count();
    expect(code(await mcp(reader.id).callToolText('hadron_ask_question', { logRef: logId, ...ASK }))).toBe('question_forbidden');
    expect(code(await mcp(holder.id).callToolText('hadron_ask_question', { logRef: logId, title: 'No rec', options: ASK.options })))
      .toBe('question_recommendation_missing');
    expect(code(await mcp(holder.id).callToolText('hadron_ask_question', { logRef: logId, ...ASK, assignee: reader.id })))
      .toBe('question_assignee_not_decider');
    expect(await db.node.count()).toBe(before);
    const { text, urn } = await workerAsks();
    const stale = await asWorker(() => mcp(holder.id).callToolText('hadron_amend_question', {
      ref: urn, expectedRevision: revOf(text) + 5, reason: 'typo', title: 'Changed',
    }));
    expect(code(stale)).toBe('node_write_conflict');
    expect((await dataOf(urn)).data.title).toBe(ASK.title);
  });
});

describe('#4430 impersonation: the Context carries it, so every write is refused as on GraphQL', () => {
  it('an impersonated caller asking and answering is refused [question_impersonation_refused] and writes nothing', async () => {
    const before = await db.node.count();
    const imp = { impersonation: { by: admin.id, orgId: org.id } } as unknown as Partial<AuthContext>;
    expect(code(await mcp(holder.id, imp).callToolText('hadron_ask_question', { logRef: logId, ...ASK }))).toBe('question_impersonation_refused');
    expect(await db.node.count()).toBe(before);
    const { text, urn } = await workerAsks();
    expect(code(await mcp(holder.id, imp).callToolText('hadron_answer_question', { ref: urn, expectedRevision: revOf(text), optionKey: 'ship' })))
      .toBe('question_impersonation_refused');
    expect((await dataOf(urn)).data.answers).toHaveLength(0);
  });
});

describe('#4430 answering: an agent never answers, a person on a plain session does', () => {
  it('the worker session of the asker is refused [question_not_decider], even though its holder decides', async () => {
    const { text, urn } = await workerAsks();
    const refused = await asWorker(() => mcp(holder.id).callToolText('hadron_answer_question', { ref: urn, expectedRevision: revOf(text), optionKey: 'ship' }));
    expect(code(refused)).toBe('question_not_decider');
    expect((await dataOf(urn)).data.answers).toHaveLength(0);
  });

  it('the decider on a plain MCP session answers with via mcp; retract returns it to OPEN', async () => {
    const { text, urn } = await workerAsks();
    const answered = await mcp(holder.id).callToolText('hadron_answer_question', { ref: urn, expectedRevision: revOf(text), optionKey: 'ship', reason: 'go' });
    expect(code(answered), answered).toBe('NO_ERROR');
    const { data } = await dataOf(urn);
    expect(data.answers).toHaveLength(1);
    expect(data.answers[0]).toMatchObject({ kind: 'answer', key: 'ship', via: 'mcp' });
    expect(JSON.stringify(data.answers[0].by)).toContain(holder.id);
    const retracted = await mcp(holder.id).callToolText('hadron_retract_question_answer', { ref: urn, expectedRevision: revOf(answered), reason: 'too soon' });
    expect(code(retracted), retracted).toBe('NO_ERROR');
    expect(retracted).toContain('State: OPEN');
    expect((await dataOf(urn)).data.answers.at(-1)).toMatchObject({ kind: 'retraction', via: 'mcp' });
  });

  it('via is not an argument: a via the caller sends is ignored and the entry still says mcp', async () => {
    const { text, urn } = await workerAsks();
    await mcp(holder.id).callTool('hadron_answer_question', { ref: urn, expectedRevision: revOf(text), optionKey: 'ship', via: 'PORTAL' });
    expect((await dataOf(urn)).data.answers[0]).toMatchObject({ via: 'mcp' });
  });
});

describe('#4430 the asker\'s pull and withdraw', () => {
  it('askedByMe with answeredSince sees the question once answered, and not with a later answeredSince', async () => {
    const { text, urn } = await workerAsks();
    const before = new Date(Date.now() - 1000).toISOString();
    await mcp(holder.id).callToolText('hadron_answer_question', { ref: urn, expectedRevision: revOf(text), optionKey: 'ship' });
    const pulled = await asWorker(() => mcp(holder.id).callToolText('hadron_list_questions', { askedByMe: true, answeredSince: before, logRef: logId }));
    expect(pulled).toMatch(/^1 of 1/);
    expect(pulled).toContain(urn);
    const later = new Date(Date.now() + 60_000).toISOString();
    const none = await asWorker(() => mcp(holder.id).callToolText('hadron_list_questions', { askedByMe: true, answeredSince: later, logRef: logId }));
    expect(none).toMatch(/^0 of 0/);
  });

  it('the asking worker withdraws its unanswered question; after an answer it is refused [question_not_decider]', async () => {
    const first = await workerAsks();
    const withdrawn = await asWorker(() => mcp(holder.id).callToolText('hadron_withdraw_question', { ref: first.urn, expectedRevision: revOf(first.text), reason: 'not needed' }));
    expect(code(withdrawn), withdrawn).toBe('NO_ERROR');
    expect(withdrawn).toContain('State: WITHDRAWN');
    const second = await workerAsks({ ...ASK, title: 'Second?' });
    const answered = await mcp(holder.id).callToolText('hadron_answer_question', { ref: second.urn, expectedRevision: revOf(second.text), optionKey: 'ship' });
    const late = await asWorker(() => mcp(holder.id).callToolText('hadron_withdraw_question', { ref: second.urn, expectedRevision: revOf(answered), reason: 'late' }));
    expect(code(late)).toBe('question_not_decider');
  });
});

describe('#4430 doors and absences', () => {
  it('the generic hadron_create_node with role question is refused and names hadron_ask_question', async () => {
    const text = await mcp(holder.id).callToolText('hadron_create_node', {
      urn: `hrn:node:${memory.urn}:questions:QZZ`, name: 'Sneaky', content: 'x', role: 'question',
    });
    expect(text).toContain('hadron_ask_question');
  });

  it('MCP offers no question approval, and the eight tools are registered', async () => {
    const names = mcp(holder.id).toolNames();
    expect(names.filter((n) => /approve.*question|question.*approv/.test(n))).toEqual([]);
    for (const n of ['hadron_list_question_logs', 'hadron_ask_question', 'hadron_get_question', 'hadron_list_questions',
      'hadron_amend_question', 'hadron_withdraw_question', 'hadron_answer_question', 'hadron_retract_question_answer']) {
      expect(names).toContain(n);
    }
    expect(mcp(holder.id).toolDescription('hadron_answer_question')).toContain('an agent does not answer its own question');
  });
});

describe('#4430 over HTTP: a worker session the CLI started, presented by header, asks as that worker', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createHttpServer(await createServerOnCleanDb());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('askedBy.workerId is the bound worker, and that session cannot answer', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'qmcp.example:engineer', name: 'engineer', organizationId: org.id } });
    const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'qmcp.example:team', organizationId: org.id } });
    await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
    const iris = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const { rawKey } = await mintUserApiKey(db, { userId: holder.id, label: null, createdBy: holder.id, issuedVia: 'test' });
    const workerSessionId = await startWorkerSessionGql({ workerRef: iris.id, userId: holder.id, appId: app.id });
    const headers = { 'x-hadron-session': workerSessionId, authorization: `Bearer ${rawKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '4430', version: '1' } } }) });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    let id = 10;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }) });
      expect(res.status).toBe(200);
      return res.text();
    };
    const asked = await call('hadron_ask_question', { logRef: logId, ...ASK });
    const urn = urnOf(asked)!;
    expect(urn, asked).toBeTruthy();
    expect((await dataOf(urn)).data.askedBy.workerId).toBe(iris.id);
    const refused = await call('hadron_answer_question', { ref: urn, expectedRevision: revOf(asked), optionKey: 'ship' });
    expect(refused).toContain('[question_not_decider]');
    expect((await dataOf(urn)).data.answers).toHaveLength(0);
  });
});
