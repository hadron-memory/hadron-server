/**
 * #5284 (S4 of #4360) — `Query.agentInstructions` and `hadron_get_instructions`: one call that answers the role task
 * to follow, with its body, or that no task fits (Proposed cor:dmo:050:24; cor:dmo:050:15's "Finding a task by
 * phrase"; the `instructions.no-match` reservation under cor:agt:110:01).
 *
 * Scores are exact: every task's abstract vector is a unit basis vector (or a fixed mix), and each phrase embeds to
 * a chosen unit vector, so a task's score is the cosine similarity the test names (1.0, 0.7071, 0.4, 0).
 */
import { ApolloServer } from '@apollo/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { upsertAbstractVector } from '../../../services/embedding/vectors.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { emitEntityUrnV2 } from '../../../lib/urnEmit.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

const DIM = 768;
const basis = (i: number) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const mix = (parts: Array<[number, number]>) => {
  const v = new Array(DIM).fill(0);
  for (const [i, w] of parts) v[i] = w;
  return v;
};
/** What each phrase embeds to. An unknown phrase embeds to e8, which no task's abstract shares (score 0). */
const QUERY: Record<string, number[]> = {
  'deploy failed': basis(0),
  'review the pull request': basis(1),
  'something weak': basis(2),
  'deploy or review': mix([[0, Math.SQRT1_2], [1, Math.SQRT1_2]]),
  'loner work': basis(5),
};
const embedAll = () => setEmbeddingClientForTests({
  provider: 'test', model: '5284', dim: DIM,
  embed: async (texts: string[]) => texts.map((t) => QUERY[t] ?? basis(8)),
} as never);

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let app: { id: string };
type A = { id: string; urn: string; memoryId: string };
let team: A, engineer: A, coder: A, loner: A;
let coderWorker: { id: string };
type T = { id: string; memoryId: string; loc: string };
let deploy: T, review: T, weak: T, closeChildren: T, askCoordinator: T, lonerTask: T;

async function agent(name: string, parent?: string): Promise<A> {
  const a = await M.createAgent({}, { orgRef: org.id, name }, ctx(admin.id));
  if (parent) await db.agent.update({ where: { id: a.id }, data: { extendsAgentId: parent } });
  const row = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
  return { id: a.id, urn: row.urn, memoryId: row.systemMemoryId as string };
}
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
const entry = (memoryId: string, code: string, taskLoc: string) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code, taskLoc } } });
async function task(memoryId: string, loc: string, abstract: string, vector: number[] | null, content = `${loc} body`): Promise<T> {
  const n = await node(memoryId, loc, { isRunnable: true, abstract, content });
  if (vector) await upsertAbstractVector(db, { nodeId: n.id, memoryId, provider: 'test', model: '5284', dim: DIM, embedding: vector });
  return { id: n.id, memoryId, loc };
}

const QUERY_DOC = `query($a: ID, $p: ID, $ph: String, $c: String) {
  agentInstructions(agentRef: $a, appRef: $p, phrase: $ph, eventCode: $c) {
    state route instructions
    register { code state taskLoc taskUrn }
    candidates { score trigger matchedBy node { id loc content inheritedFrom { agentId } } }
    nearest { score node { id loc } }
    fallback { node { id loc } }
  }
}`;
const apollo = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function run(query: string, variables: Record<string, unknown>, c: Context) {
  const res = await apollo.executeOperation({ query, variables }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('expected a single result');
  return res.body.singleResult as { data?: any; errors?: Array<{ message: string; extensions?: any }> };
}
/** The answer, or the first refusal as `{ code, message }`. */
async function ask(vars: { a?: string | null; p?: string | null; ph?: string | null; c?: string | null }, c: Context = ctx(admin.id)) {
  const r = await run(QUERY_DOC, vars, c);
  if (r.errors?.length) return { refused: { code: r.errors[0].extensions?.code, message: r.errors[0].message } };
  return r.data.agentInstructions;
}
const asWorker = <R>(agentId: string, fn: () => Promise<R>): Promise<R> =>
  requestActorStorage.run({ workerId: coderWorker.id, agentId }, fn);
const locs = (xs: Array<{ node: { loc: string } }>) => xs.map((x) => x.node.loc);

beforeEach(async () => {
  vi.stubEnv('EMBEDDING_API_URL', 'http://stub.invalid');
  vi.stubEnv('EMBEDDING_BACKEND', 'http');
  vi.stubEnv('TASK_MATCH_MIN_SCORE', '');
  resetEmbeddingClientForTests();
  embedAll();
  await cleanDb(db);
  const s = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'ins-org', urn: `ins-${s}.example` } });
  admin = await db.user.create({ data: { handle: `ins-admin-${s}` } });
  outsider = await db.user.create({ data: { handle: `ins-out-${s}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });

  // Team Agent (the register) and the asking chain Coder -> Engineer; Loner is in no App.
  team = await agent('Team Agent');
  engineer = await agent('Engineer');
  coder = await agent('Coder', engineer.id);
  loner = await agent('Loner');
  await db.appAgent.create({ data: { appId: app.id, agentId: team.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: engineer.id } });
  await node(team.memoryId, 'roles'); // the Team Agent marker
  coderWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: coder.id, name: 'Liam', slug: 'liam' }, select: { id: true } });

  await entry(team.memoryId, 'task.finish.open-children', 'tasks:close-children');
  await entry(team.memoryId, 'instructions.no-match', 'tasks:ask-coordinator');

  await node(coder.memoryId, 'notes:deploy', { content: 'INCLUDED-DEPLOY-NOTE' });
  deploy = await task(coder.memoryId, 'tasks:deploy', 'Fix a failed deploy', basis(0), 'Deploy steps. {{> notes:deploy}}');
  await node(engineer.memoryId, 'notes:review', { content: 'INCLUDED-REVIEW-NOTE' });
  review = await task(engineer.memoryId, 'tasks:review', 'Review a pull request', basis(1), 'Review steps. {{> notes:review}}');
  weak = await task(coder.memoryId, 'tasks:weak', 'A weakly related chore', mix([[2, 0.4], [9, Math.sqrt(1 - 0.16)]]));
  closeChildren = await task(engineer.memoryId, 'tasks:close-children', 'Close the open children of a task', basis(3));
  askCoordinator = await task(engineer.memoryId, 'tasks:ask-coordinator', 'Ask the coordinator what to do', basis(4));
  lonerTask = await task(loner.memoryId, 'tasks:loner', 'Loner work', basis(5));
});
afterEach(() => { vi.unstubAllEnvs(); resetEmbeddingClientForTests(); });

describe('#5284 the ranked list: score, phrase, cap', () => {
  const list = (args: Record<string, unknown>) => (resolvers.Query as any).agentTaskList({}, { ref: coder.id, ...args }, ctx(admin.id));

  it('ranks by the abstract and carries the vector score', async () => {
    const hits = await list({ phrase: 'deploy failed', limit: 2 });
    expect(hits[0].node.id).toBe(deploy.id);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(typeof hits[1].score).toBe('number');
    expect(hits[1].score).toBeLessThan(hits[0].score);
  });

  // #5360 N1: this and its NO_MATCH twin below are THE guard for "a task the search could not score is never
  // MATCHED" — the keyword fallback's `score: null` mapping (agentDefinitionLists.ts) is what makes an unscored
  // task unable to reach the floor. Keep them as that guard if the fallback ever changes (#2421).
  it('GUARD (unscored never MATCHED): with embeddings unavailable the keyword fallback maps score null, so the list carries no score', async () => {
    vi.stubEnv('EMBEDDING_API_URL', '');
    resetEmbeddingClientForTests();
    const hits = await list({ phrase: 'deploy' });
    expect(hits.map((h: any) => [h.node.id, h.matchedBy, h.score])).toEqual([[deploy.id, 'KEYWORD', null]]);
  });

  it('the old symptom argument is refused by the schema', async () => {
    const r = await run('{ agentTaskList(ref: "x", symptom: "deploy") { trigger } }', {}, ctx(admin.id));
    expect(r.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(r.errors?.[0]?.message).toContain('symptom');
  });

  it('MCP hadron_agent_tasks takes phrase and prints the score', async () => {
    const srv = createTestableMcpServer({ ...ctx(admin.id), clientId: `user:${admin.id}` } as never);
    const text = await srv.callToolText('hadron_agent_tasks', { agentRef: coder.id, phrase: 'deploy failed', limit: 1 });
    expect(text).toContain('tasks:deploy');
    expect(text).toContain('Score: 1.00');
  });
});

describe('#5284 agentInstructions: input', () => {
  it.each([
    ['neither phrase nor eventCode', { a: null, p: null }],
    ['an empty phrase', { ph: '   ' }],
    ['a phrase over 512 characters', { ph: 'x'.repeat(513) }], // #5360 B2: 512 for both (Holger, 2026-11-27)
    ['an eventCode without appRef', { c: 'task.finish.open-children' }],
  ])('%s is BAD_USER_INPUT', async (_n, vars) => {
    expect((await ask({ a: coder.id, ...vars })).refused?.code).toBe('BAD_USER_INPUT');
  });
  it('a 500-character phrase is answered', async () => {
    expect((await ask({ a: coder.id, ph: 'x'.repeat(500) })).state).toBe('NO_MATCH');
  });
});

// #5360 — the #5347 follow-ups (gate CHECKED, issue #5360): one shared phrase bound (512, Holger's ruling of
// 2026-11-27 "512 for both"), a trimmed and length-bounded event code, the stale-mapping answer, validation
// before the read, the keyword-only tail and the floor boundary.
describe('#5360 input bounds: one shared 512 phrase bound, a trimmed and bounded event code, both before any read', () => {
  it('a 505-character phrase is answered (501-512 were refused by the old 500 cap; the list\'s 512 bound now governs both)', async () => {
    expect((await ask({ a: coder.id, ph: 'x'.repeat(505) })).state).toBe('NO_MATCH');
  });
  it('a 512-character phrase is answered and a 513-character one is BAD_USER_INPUT', async () => {
    expect((await ask({ a: coder.id, ph: 'x'.repeat(512) })).state).toBe('NO_MATCH');
    expect((await ask({ a: coder.id, ph: 'x'.repeat(513) })).refused?.code).toBe('BAD_USER_INPUT');
  });
  it('an event code is trimmed before the register read', async () => {
    const r = await ask({ a: coder.id, p: app.id, c: '  task.finish.open-children  ' });
    expect([r.state, r.route, r.register.state]).toEqual(['MATCHED', 'REGISTER', 'MAPPED']);
  });
  it('an event code longer than a code can be (64, the register loc atom bound, cor:agt:110:01) is BAD_USER_INPUT; one of exactly 64 is taken', async () => {
    expect((await ask({ a: coder.id, p: app.id, c: `${'a'.repeat(63)}.x` })).refused?.code).toBe('BAD_USER_INPUT');
    expect((await ask({ a: coder.id, p: app.id, c: `${'a'.repeat(62)}.x` })).state).toBe('NO_MATCH');
  });
  it('both bounds run before any read: they win over an unknown Agent and an unknown App', async () => {
    expect((await ask({ a: generateId(), ph: 'x'.repeat(513) })).refused?.code).toBe('BAD_USER_INPUT');
    expect((await ask({ a: generateId(), p: app.id, c: 'x'.repeat(65) })).refused?.code).toBe('BAD_USER_INPUT');
    expect((await ask({ a: coder.id, p: generateId(), c: 'x'.repeat(65) })).refused?.code).toBe('BAD_USER_INPUT');
  });
});

describe('#5360 a stale mapping: register MAPPED, task not in the asking Agent\'s list', () => {
  it('answers NO_MATCH with register still MAPPED (cor:dmo:050:24 S1/S2 do not state otherwise; the answer is reported, the task is not invented)', async () => {
    // The register resolves a loc through the asking Agent's own memory, where a pos-1 node is locatable whatever
    // its node type (effectiveSystemMemory filters comments only on INHERITED positions), and it asks only
    // runnable + live + readable. The task LIST excludes a comment unconditionally (agentDefinitionLists, #1935),
    // so a runnable comment at a task loc in the Agent's own memory is the deterministic stale shape: the entry
    // maps, yet the task is never in the list the answer is allowed to serve. Built by hand in one transaction
    // (the comment invariants are deferred to commit): target, comment node, meta, anchor edge.
    const target = await node(coder.memoryId, 'notes:stale-target');
    const retired = generateId();
    await db.$transaction(async (tx) => {
      await tx.node.create({ data: { id: retired, memoryId: coder.memoryId, loc: 'tasks:retired', name: 'Retired chore', nodeType: 'comment', isRunnable: true, abstract: 'A chore that is no longer runnable', content: 'gone' } });
      await tx.commentMeta.create({ data: { nodeId: retired, targetNodeId: target.id, threadState: 'OPEN', authorKey: `u:${admin.id}` } });
      await tx.edge.create({ data: { memoryId: coder.memoryId, sourceId: retired, targetId: target.id, loc: `tasks:retired:anchor`, name: 'comment-anchor', governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: 'a'.repeat(64) } });
    });
    await entry(team.memoryId, 'task.stale.mapping', 'tasks:retired');
    const r = await ask({ a: coder.id, p: app.id, c: 'task.stale.mapping' });
    expect(r.register.state).toBe('MAPPED');
    expect([r.state, r.route]).toEqual(['NO_MATCH', null]);
    expect(r.candidates).toEqual([]);
    expect(r.instructions).toBeNull();
    expect(r.fallback.node.id).toBe(askCoordinator.id); // the instructions.no-match fallback still applies
  });
});

describe('#5360 the task list validates before it reads', () => {
  const refusalOf = async (ref: string, args: Record<string, unknown>) =>
    (await run('query($r: ID!, $ph: String, $l: Int) { agentTaskList(ref: $r, phrase: $ph, limit: $l) { trigger } }', { r: ref, ...args }, ctx(admin.id)))
      .errors?.[0]?.extensions?.code;
  it('an invalid limit is BAD_USER_INPUT even for an unknown Agent (the check runs before the gate read)', async () => {
    expect(await refusalOf(generateId(), { ph: 'deploy failed', l: 11 })).toBe('BAD_USER_INPUT');
  });
  it('an over-long phrase is BAD_USER_INPUT before the read (512, the bound shared with agentInstructions)', async () => {
    expect(await refusalOf(generateId(), { ph: 'x'.repeat(513) })).toBe('BAD_USER_INPUT');
  });
  it('a valid ranked call still reads the gate first: an unknown Agent is AGENT_NOT_FOUND, as before', async () => {
    expect(await refusalOf(generateId(), { ph: 'deploy failed' })).toBe('AGENT_NOT_FOUND');
  });
});

describe('#5360 the keyword-only tail under a live embedding', () => {
  it('a keyword hit with no abstract vector follows every scored task, score null, matchedBy KEYWORD', async () => {
    // The keyword half is an AND over the phrase's words, so the manual task's abstract carries both ('deploy',
    // 'failed'); it has no abstract VECTOR, so under the live embedding it is the keyword-only tail.
    const manual = await task(coder.memoryId, 'tasks:manual', 'Deploy the failed service by hand', null);
    const hits = await (resolvers.Query as any).agentTaskList({}, { ref: coder.id, phrase: 'deploy failed', limit: 10 }, ctx(admin.id));
    expect(hits[0].node.id).toBe(deploy.id);
    expect(hits[0].matchedBy).toBe('BOTH');
    expect(typeof hits[0].score).toBe('number');
    const tail = hits[hits.length - 1];
    expect(tail.node.id).toBe(manual.id);
    expect([tail.matchedBy, tail.score]).toEqual(['KEYWORD', null]);
    expect(hits.slice(0, -1).every((h: any) => h.score != null)).toBe(true);
  });
});

describe('#5360 the floor boundary', () => {
  it('a task scoring exactly the floor is MATCHED (>=, not >)', async () => {
    const under = await ask({ a: coder.id, ph: 'something weak' });
    const measured = (under.nearest.find((n: any) => n.node.loc === 'tasks:weak') as { score: number }).score;
    expect(measured).toBeCloseTo(0.4, 5);
    vi.stubEnv('TASK_MATCH_MIN_SCORE', String(measured)); // String round-trips the exact double: floor === score
    const r = await ask({ a: coder.id, ph: 'something weak' });
    expect([r.state, locs(r.candidates)]).toEqual(['MATCHED', ['tasks:weak']]);
  });
});

describe('#5284 agentInstructions: the register arm', () => {
  it('a mapped event code is MATCHED through the REGISTER, the task resolved through the asking chain, with its body', async () => {
    const r = await ask({ a: coder.id, p: app.id, c: 'task.finish.open-children' });
    expect(r.state).toBe('MATCHED');
    expect(r.route).toBe('REGISTER');
    expect(r.register.state).toBe('MAPPED');
    expect(locs(r.candidates)).toEqual(['tasks:close-children']);
    expect(r.candidates[0].node.id).toBe(closeChildren.id);
    expect(r.candidates[0].node.inheritedFrom.agentId).toBe(engineer.id);
    expect(r.instructions).toBe(r.candidates[0].node.content);
    expect(r.nearest).toEqual([]);
  });
  it('an unmapped code with a phrase falls through to the SEARCH', async () => {
    const r = await ask({ a: coder.id, p: app.id, c: 'no.such.code', ph: 'deploy failed' });
    expect([r.state, r.route, r.register.state]).toEqual(['MATCHED', 'SEARCH', 'UNMAPPED']);
    expect(locs(r.candidates)[0]).toBe('tasks:deploy');
  });
  it('an unmapped code alone is NO_MATCH and register.state says why', async () => {
    const r = await ask({ a: coder.id, p: app.id, c: 'no.such.code' });
    expect([r.state, r.route, r.register.state]).toEqual(['NO_MATCH', null, 'UNMAPPED']);
    expect(r.candidates).toEqual([]);
    expect(r.instructions).toBeNull();
  });
  it('without an event code, register is null', async () => {
    expect((await ask({ a: coder.id, ph: 'deploy failed' })).register).toBeNull();
  });
});

describe('#5284 agentInstructions: the search arm and the floor', () => {
  it('an abstract at or above the floor is MATCHED by SEARCH, with its score', async () => {
    const r = await ask({ a: coder.id, ph: 'deploy failed' });
    expect([r.state, r.route]).toEqual(['MATCHED', 'SEARCH']);
    expect(locs(r.candidates)).toEqual(['tasks:deploy']);
    expect(r.candidates[0].score).toBeCloseTo(1, 5);
    expect(r.nearest).toEqual([]);
  });
  it('candidates are the tasks at or above the floor, best first, at most 3', async () => {
    const r = await ask({ a: coder.id, ph: 'deploy or review' });
    expect(r.state).toBe('MATCHED');
    expect(locs(r.candidates).sort()).toEqual(['tasks:deploy', 'tasks:review']);
    expect(r.candidates.every((c: any) => c.score >= 0.45)).toBe(true);
  });
  it('an abstract under the floor is NO_MATCH: nearest filled, no candidates, no body', async () => {
    const r = await ask({ a: coder.id, ph: 'something weak' });
    expect([r.state, r.route]).toEqual(['NO_MATCH', null]);
    expect(r.candidates).toEqual([]);
    expect(r.instructions).toBeNull();
    expect(r.nearest[0].node.loc).toBe('tasks:weak');
    expect(r.nearest[0].score).toBeCloseTo(0.4, 5);
    expect(r.nearest.length).toBeLessThanOrEqual(3);
  });
  it('a nonsense phrase is NO_MATCH', async () => {
    const r = await ask({ a: coder.id, ph: 'zzqx blorf' });
    expect(r.state).toBe('NO_MATCH');
    expect(r.candidates).toEqual([]);
    expect(r.instructions).toBeNull();
  });
  // #5360 N1: the NO_MATCH half of the "unscored never MATCHED" guard — see the keyword-list pin above.
  it('GUARD (unscored never MATCHED): with embeddings unavailable a keyword hit is NO_MATCH with the hits in nearest, never MATCHED', async () => {
    vi.stubEnv('EMBEDDING_API_URL', '');
    resetEmbeddingClientForTests();
    const r = await ask({ a: coder.id, ph: 'deploy' });
    expect([r.state, r.route, r.instructions]).toEqual(['NO_MATCH', null, null]);
    expect(r.candidates).toEqual([]);
    expect(locs(r.nearest)).toEqual(['tasks:deploy']);
    expect(r.nearest[0].score).toBeNull();
  });
  it('with the embedding call failing, the answer is the same NO_MATCH', async () => {
    setEmbeddingClientForTests({ provider: 'test', model: '5284', dim: DIM, embed: async () => { throw new Error('down'); } } as never);
    const r = await ask({ a: coder.id, ph: 'deploy' });
    expect([r.state, r.instructions, locs(r.nearest)]).toEqual(['NO_MATCH', null, ['tasks:deploy']]);
  });
  it.each(['0', '1', 'abc', '', '-0.2', '1.5', '3e-1', '0x0'])('TASK_MATCH_MIN_SCORE=%j uses the default 0.45', async (v) => {
    vi.stubEnv('TASK_MATCH_MIN_SCORE', v);
    expect((await ask({ a: coder.id, ph: 'something weak' })).state).toBe('NO_MATCH');
    expect((await ask({ a: coder.id, ph: 'deploy failed' })).state).toBe('MATCHED');
  });
  it('TASK_MATCH_MIN_SCORE=0.3 lowers the floor', async () => {
    vi.stubEnv('TASK_MATCH_MIN_SCORE', '0.3');
    const r = await ask({ a: coder.id, ph: 'something weak' });
    expect([r.state, locs(r.candidates)]).toEqual(['MATCHED', ['tasks:weak']]);
  });
});

describe('#5284 agentInstructions: the body', () => {
  it('an own task: instructions equals its content read in the same request, include resolved', async () => {
    const r = await ask({ a: coder.id, ph: 'deploy failed' });
    expect(r.instructions).toBe(r.candidates[0].node.content);
    expect(r.instructions).toBe('Deploy steps. INCLUDED-DEPLOY-NOTE');
  });
  it('an inherited task: read through the asking Agent, include resolved', async () => {
    const r = await ask({ a: coder.id, ph: 'review the pull request' });
    expect(r.candidates[0].node.id).toBe(review.id);
    expect(r.candidates[0].node.inheritedFrom.agentId).toBe(engineer.id);
    expect(r.instructions).toBe(r.candidates[0].node.content);
    expect(r.instructions).toBe('Review steps. INCLUDED-REVIEW-NOTE');
  });
  it('only the best task has a body: runners-up are named only', async () => {
    const r = await ask({ a: coder.id, ph: 'deploy or review' });
    expect(r.instructions).toBe(r.candidates[0].node.content);
    expect(r.instructions).not.toContain(r.candidates[1].node.content);
  });
});

describe('#5284 agentInstructions: the no-match fallback (R6)', () => {
  it('NO_MATCH asked in an App returns the task instructions.no-match maps', async () => {
    const r = await ask({ a: coder.id, p: app.id, ph: 'zzqx blorf' });
    expect(r.state).toBe('NO_MATCH');
    expect(r.fallback.node.id).toBe(askCoordinator.id);
    expect(r.instructions).toBeNull();
  });
  it('without an App there is no fallback', async () => {
    expect((await ask({ a: coder.id, ph: 'zzqx blorf' })).fallback).toBeNull();
  });
  it('MATCHED has no fallback', async () => {
    expect((await ask({ a: coder.id, p: app.id, ph: 'deploy failed' })).fallback).toBeNull();
  });
});

describe('#5284 agentInstructions: who is asking', () => {
  it('a bound worker naming no Agent gets its own Agent, with and without an App', async () => {
    const inApp = await asWorker(coder.id, () => ask({ p: app.id, ph: 'deploy failed' }));
    expect(locs(inApp.candidates)).toEqual(['tasks:deploy']);
    const noApp = await asWorker(coder.id, () => ask({ ph: 'review the pull request' }));
    expect(noApp.candidates[0].node.id).toBe(review.id);
  });
  it('a person naming no Agent is BAD_USER_INPUT, with and without an App', async () => {
    expect((await ask({ ph: 'deploy failed' })).refused?.code).toBe('BAD_USER_INPUT');
    expect((await ask({ p: app.id, ph: 'deploy failed' })).refused?.code).toBe('BAD_USER_INPUT');
  });
  it('with no appRef, an Agent in no team App gets an answer', async () => {
    const r = await ask({ a: loner.id, ph: 'loner work' });
    expect([r.state, locs(r.candidates)]).toEqual(['MATCHED', ['tasks:loner']]);
    expect(lonerTask.loc).toBe('tasks:loner');
  });
});

describe('#5284 agentInstructions: access', () => {
  it('an Agent neither installed nor cast in the App is AGENT_NOT_FOUND', async () => {
    expect((await ask({ a: loner.id, p: app.id, ph: 'loner work' })).refused?.code).toBe('AGENT_NOT_FOUND');
  });
  it('a caller who does not take part in the App is APP_NOT_FOUND, as for an unknown App', async () => {
    const known = await ask({ a: coder.id, p: app.id, ph: 'deploy failed' }, ctx(outsider.id));
    const unknown = await ask({ a: coder.id, p: generateId(), ph: 'deploy failed' }, ctx(outsider.id));
    expect(known.refused?.code).toBe('APP_NOT_FOUND');
    expect(unknown.refused?.code).toBe('APP_NOT_FOUND');
  });
  it('without an App, an unreadable Agent is refused exactly as an unknown one', async () => {
    const ghost = generateId();
    const unreadable = await ask({ a: coder.id, ph: 'deploy failed' }, ctx(outsider.id));
    const unknown = await ask({ a: ghost, ph: 'deploy failed' }, ctx(outsider.id));
    expect(unreadable.refused?.code).toBe('AGENT_NOT_FOUND');
    expect(JSON.stringify(unreadable).split(coder.id).join('<ref>')).toBe(JSON.stringify(unknown).split(ghost).join('<ref>'));
  });
  it('the same refusal through the list and through agentInstructions for an unreadable Agent', async () => {
    const viaList = await run('query($r: ID!) { agentTaskList(ref: $r, phrase: "deploy failed") { trigger } }', { r: coder.id }, ctx(outsider.id));
    const viaCall = await ask({ a: coder.id, ph: 'deploy failed' }, ctx(outsider.id));
    expect(viaCall.refused).toEqual({ code: viaList.errors?.[0]?.extensions?.code, message: viaList.errors?.[0]?.message });
  });
});

describe('#5284 nothing logged, surfaces agree', () => {
  it('never logs the phrase, the event code or a task loc', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));
    try {
      await ask({ a: coder.id, p: app.id, c: 'secret.code.5284', ph: 'secret phrase 5284 deploy failed' });
      await ask({ a: coder.id, p: app.id, c: 'task.finish.open-children' });
      const said = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      for (const word of ['secret phrase 5284', 'secret.code.5284', 'task.finish.open-children', 'tasks:', 'instructions.no-match']) {
        expect(said).not.toContain(word);
      }
    } finally { for (const s of spies) s.mockRestore(); }
  });

  it('GraphQL and MCP return the same tasks in the same order, and MCP renders the body on a match', async () => {
    const srv = createTestableMcpServer({ ...ctx(admin.id), clientId: `user:${admin.id}` } as never);
    const urnOf = async (t: T) => `hrn:node:${(await db.memory.findUniqueOrThrow({ where: { id: t.memoryId } })).urn}:${t.loc}`;
    const r = await ask({ a: coder.id, ph: 'deploy or review' });
    const text = await srv.callToolText('hadron_get_instructions', { agentRef: coder.id, phrase: 'deploy or review' });
    const order = await Promise.all(r.candidates.map((c: any) => urnOf([deploy, review].find((t) => t.id === c.node.id)!)));
    const positions = order.map((u) => text.indexOf(u));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(text.startsWith('Follow this task:')).toBe(true);
    expect(text).toContain(r.instructions);
    expect(text).toContain('Other candidates:');

    const none = await srv.callToolText('hadron_get_instructions', { agentRef: coder.id, phrase: 'something weak' });
    expect(none.startsWith('No task matches this phrase.')).toBe(true);
    expect(none).toContain('Nearest, under the match floor (not instructions):');
    expect(none).toContain(await urnOf(weak));
    expect(none).not.toContain('tasks:weak body');
  });

  it('MCP refuses as GraphQL does', async () => {
    const srv = createTestableMcpServer({ ...ctx(outsider.id), clientId: `user:${outsider.id}` } as never);
    const text = await srv.callToolText('hadron_get_instructions', { agentRef: coder.id, phrase: 'deploy failed' });
    expect(text).toContain('[AGENT_NOT_FOUND]');
    expect(emitEntityUrnV2('agent', coder.urn)).toBeTruthy();
  });
});
