/**
 * #4604 (Questions follow-ups F2-F5, from George's blind read of #4547). One pin per finding:
 *   F2  the list evaluates at most cap rows, judged by ONE bounded fetch (an insert between a count and a fetch cannot exceed the cap);
 *   F3  every sort is a TOTAL order: two rows with the same n and loc (two memories under App scope) end on the row id;
 *   F4  a mutation result reports the same effective assignee as the next read;
 *   F5  the asker pull resolves the caller's identities once per request, after the cheap filters, and answers as the per-row rule does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
import { runAsActor } from '../../../lib/requestActor.js';
import * as questionsModule from './resolvers.questions.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let reader: { id: string };
let kay: { id: string };
let app: { id: string; urn: string };
let memA: { id: string };
let memB: { id: string };
let platformAdmin: { id: string };
let logA: { row: { id: string } };
let logB: { row: { id: string } };

const as = (userId = admin.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const D = (resolvers as unknown as { Question: Record<string, (v: any, a: unknown, ctx: Context) => any> }).Question;

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};

const simple = (extra: Record<string, unknown> = {}) => ({
  title: 'Ship the codec?', yesno: true, recommendation: { key: 'yes', reason: 'ready' }, ...extra,
});
const ask = (logRef: string, input: Record<string, unknown> = simple(), userId = writer.id, extra: Partial<Context> = {}) =>
  M.askQuestion(null, { logRef, input }, as(userId, extra));
const asWorker = <T>(workerId: string, fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);
const ids = (page: { items: Array<{ row: { id: string } }> }) => page.items.map((v) => v.row.id);
const idSet = (page: { items: Array<{ row: { id: string } }> }) => ids(page).sort();

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'List Org', urn: 'list.example' } });
  admin = await db.user.create({ data: { githubId: 442801, githubUsername: 'ql-admin', handle: 'ql-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 442802, githubUsername: 'ql-writer', handle: 'ql-writer', roles: [] } });
  holger = await db.user.create({ data: { githubId: 442803, githubUsername: 'ql-holger', handle: 'ql-holger', roles: [] } });
  reader = await db.user.create({ data: { githubId: 442804, githubUsername: 'ql-reader', roles: [] } });
  platformAdmin = await db.user.create({ data: { githubId: 442807, githubUsername: 'ql-platform', roles: ['ADMIN'] } });
  kay = await db.user.create({ data: { githubId: 442806, githubUsername: 'ql-kay', handle: 'ql-kay', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: holger.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
    { organizationId: org.id, userId: kay.id, role: 'CONTRIBUTOR' },
  ] });
  // One App, two memories: A in this org (its members read it), B in another org (only its members read it).
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: 'list.example:team' } });
  memA = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'team-a' }, as());
  memB = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'team-b' }, as());
  logA = await M.createQuestionLog(null, { memoryRef: memA.id, loc: 'questions', defaultDeciders: [holger.id, admin.id] }, as());
  logB = await M.createQuestionLog(null, { memoryRef: memB.id, loc: 'questions', defaultDeciders: [admin.id] }, as());
  // Attach the memories to the App after the logs exist, so decider eligibility is judged on the plain org memories.
  // A is the App's team space (every member reads it); B is an app-class memory owned by one user (strict ownership: only admin reads it).
  await db.memory.update({ where: { id: memA.id }, data: { appId: app.id, class: 'app', visibility: null } });
  await db.memory.update({ where: { id: memB.id }, data: { appId: app.id, class: 'app', visibility: null, organizationId: null, ownerUserId: admin.id } });
  await db.appMember.createMany({ data: [admin, writer, holger, kay, reader].map((u, i) => ({ appId: app.id, userId: u.id, role: i === 0 ? 'owner' : 'member' })) });
});


/** A `db` whose node delegate is observed: `count` can be stubbed, `findMany` args recorded, and identity lookups counted. */
function observedDb(opts: { count?: number } = {}) {
  const log = { findManyArgs: [] as Array<Record<string, unknown>>, calls: [] as string[], identityLookups: 0 };
  const node = new Proxy(db.node, {
    get(target, prop, recv) {
      if (prop === 'count') return (args: unknown) => { log.calls.push('count'); return opts.count !== undefined ? Promise.resolve(opts.count) : (target.count as (a: unknown) => unknown)(args); };
      if (prop === 'findMany') return (args: Record<string, unknown>) => { log.findManyArgs.push(args); log.calls.push((args.where as { role?: string } | undefined)?.role === 'question' ? 'fetch' : 'findMany-other'); return (target.findMany as (a: unknown) => unknown)(args); };
      return Reflect.get(target, prop, recv);
    },
  });
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'node') return node;
      if (prop === '$queryRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (Array.isArray(strings) && strings.join('?').includes('JOIN ids')) log.identityLookups++;
          return (target.$queryRaw as (...a: unknown[]) => unknown)(strings, ...values);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { db: proxy as typeof db, log };
}

describe('#4604 F2: the cap bounds the fetch, not a separate count', () => {
  it('fetches at most cap + 1 rows and refuses even when a count taken earlier said the log was small', async () => {
    await ask(logA.row.id);
    await ask(logA.row.id);
    await ask(logA.row.id);
    const spy = vi.spyOn(questionsModule.questionListBounds, 'cap').mockReturnValue(2);
    try {
      // The race: the count (2 or fewer) is read, then a row is inserted, then the rows are fetched. Stubbing the count to 0 models that
      // window; a count-then-fetch list would evaluate all three rows and answer, this one refuses on the fetch itself.
      const { db: observed, log } = observedDb({ count: 0 });
      expect(await codeOf(Q.questions(null, { logRef: logA.row.id }, as(reader.id, { db: observed })))).toBe('QUESTION_LOG_TOO_LARGE_FOR_FILTER');
      // The bounded fetch is the ONLY question-row fetch, it comes first, and any count is taken afterwards (the refusal's wording).
      const questionFetches = log.findManyArgs.filter((a) => (a.where as { role?: string } | undefined)?.role === 'question');
      expect(questionFetches).toHaveLength(1);
      expect(questionFetches[0]).toMatchObject({ take: 3 });
      expect(log.calls.indexOf('fetch')).toBeGreaterThanOrEqual(0);
      expect(log.calls.indexOf('count') === -1 || log.calls.indexOf('count') > log.calls.indexOf('fetch')).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('answers at exactly the cap, and the refusal still names the cap and a count above it', async () => {
    await ask(logA.row.id);
    await ask(logA.row.id);
    const spy = vi.spyOn(questionsModule.questionListBounds, 'cap').mockReturnValue(2);
    try {
      expect((await Q.questions(null, { logRef: logA.row.id }, as(reader.id))).total).toBe(2);
      await ask(logA.row.id);
      const err = await Q.questions(null, { logRef: logA.row.id }, as(reader.id)).catch((e: GraphQLError) => e);
      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions).toMatchObject({ code: 'QUESTION_LOG_TOO_LARGE_FOR_FILTER', cap: 2, count: 3 });
    } finally { spy.mockRestore(); }
  });
});

describe('#4604 F3: every sort is a total order that ends on the row id', () => {
  const sorts = ['PORTAL_DEFAULT', 'CODE', 'ASKED_AT_DESC', 'ASKED_AT_ASC', 'PRIORITY_DESC', 'ANSWERED_AT_DESC'];
  // Two rows that tie on everything a sort looks at: the same question number and the same loc, in different memories.
  const twin = (id: string) => ({
    row: { id, loc: 'questions:Q-1', seq: 1 },
    shown: { n: 1, priority: 'normal', askedAt: '2026-11-01T00:00:00.000Z', answers: [] },
    evaluation: { state: 'OPEN' },
  }) as never;

  it.each(sorts)('%s: the same rows in any input order come out in one order, by id last', (sort) => {
    const forward = [twin('a'), twin('b'), twin('c')];
    const reversed = [...forward].reverse();
    const idsOf = (views: unknown[]) => (views as Array<{ row: { id: string } }>).map((v) => v.row.id);
    expect(idsOf(questionsModule.sortViews(forward, sort as never))).toEqual(idsOf(questionsModule.sortViews(reversed, sort as never)));
    expect(idsOf(questionsModule.sortViews(reversed, sort as never))).toEqual(['a', 'b', 'c']);
  });

  it('two memories with the same log path and question number page without overlap or gap', async () => {
    const a = await ask(logA.row.id, simple(), admin.id);
    const b = await ask(logB.row.id, simple(), admin.id);
    expect((await questionRow(a.row.id)).loc).toBe((await questionRow(b.row.id)).loc);
    for (const sort of sorts) {
      const whole = ids(await Q.questions(null, { appRef: app.id, sort }, as(admin.id)));
      const p1 = ids(await Q.questions(null, { appRef: app.id, sort, limit: 1, offset: 0 }, as(admin.id)));
      const p2 = ids(await Q.questions(null, { appRef: app.id, sort, limit: 1, offset: 1 }, as(admin.id)));
      expect([...p1, ...p2]).toEqual(whole);
      expect(new Set(whole)).toEqual(new Set([a.row.id, b.row.id]));
    }
    // CODE reads only n and loc, which tie here, so the id decides: through the query the tied rows come out in id order.
    expect(ids(await Q.questions(null, { appRef: app.id, sort: 'CODE' }, as(admin.id)))).toEqual([a.row.id, b.row.id].sort());
  });
});
const questionRow = (id: string) => db.node.findUniqueOrThrow({ where: { id } });

describe('#4604 F4: a mutation result reports what the next read reports', () => {
  it('the effective assignee of an ask, an amend and a withdraw result equals the next read\'s', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    await db.worker.update({ where: { id: 'worker-ada' }, data: { heldByUserId: holger.id } });
    const asked = await asWorker('worker-ada', () => ask(logA.row.id));
    const read = async (id: string) => D.effectiveAssigneeId(await Q.question(null, { ref: id }, as(reader.id)), {}, as());
    expect(D.effectiveAssigneeId(asked, {}, as())).toBe(holger.id);
    expect(D.effectiveAssigneeId(asked, {}, as())).toBe(await read(asked.row.id));
    const amended = await asWorker('worker-ada', () => M.amendQuestion(null, { ref: asked.row.id, input: { title: 'Ship it?' }, reason: 'reword', expectedRevision: 1 }, as(writer.id)));
    // Beckett's BLIND delta on #4644: the resolver's argument is input; a misnamed key amended nothing and went unseen.
    expect(D.title(amended, {}, as())).toBe('Ship it?');
    expect(D.title(await Q.question(null, { ref: asked.row.id }, as(reader.id)), {}, as())).toBe('Ship it?'); // stored, not only returned
    expect(D.effectiveAssigneeId(amended, {}, as())).toBe(holger.id);
    expect(await read(asked.row.id)).toBe(holger.id);
    expect(await D.effectiveAssignee(amended, {}, as(reader.id))).toMatchObject({ id: holger.id });
    const gone = await M.withdrawQuestion(null, { ref: asked.row.id, reason: 'moot', expectedRevision: amended.row.revSeq }, as(writer.id));
    expect(D.effectiveAssigneeId(gone, {}, as())).toBe(holger.id);
    expect(await read(asked.row.id)).toBe(holger.id);
  });
});

describe('#4604 F5: the asker pull resolves the caller once, after the cheap filters', () => {
  it('askedByMe makes exactly one identity lookup for the request and lists exactly the caller\'s own questions', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    const mine = [await ask(logA.row.id), await ask(logA.row.id), await ask(logA.row.id)];
    const theirs = await ask(logA.row.id, simple(), holger.id);
    const { db: observed, log } = observedDb();
    const out = await Q.questions(null, { logRef: logA.row.id, askedByMe: true }, as(writer.id, { db: observed }));
    expect(idSet(out)).toEqual(mine.map((v) => v.row.id).sort());
    expect(ids(out)).not.toContain(theirs.row.id);
    expect(log.identityLookups).toBe(1);
  });

  it('a list the cheap filters empty makes no identity lookup at all', async () => {
    await ask(logA.row.id);
    await ask(logA.row.id);
    const { db: observed, log } = observedDb();
    const out = await Q.questions(null, { logRef: logA.row.id, askedByMe: true, state: ['DECIDED'] }, as(writer.id, { db: observed }));
    expect(out).toMatchObject({ items: [], total: 0 });
    expect(log.identityLookups).toBe(0);
  });
});

describe('#4604 F5 (BLIND P2): identities are resolved only for a row that needs them, once', () => {
  it('a matching worker, an App-only caller and a worker-matched list cost no lookup; mismatched workers cost one; the answers are the per-row rule\'s', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    await createDbWorkerAttribution(db, writer.id, 'worker-bob');
    const byAda = await asWorker('worker-ada', () => ask(logA.row.id));
    const byBob = await asWorker('worker-bob', () => ask(logA.row.id));
    // The matching worker arm settles every surviving row it owns: no lookup.
    const only = observedDb();
    const adaOnly = await asWorker('worker-ada', () => Q.questions(null, { logRef: logA.row.id, askedByMe: true, askedByWorkerId: 'worker-ada' }, as(writer.id, { db: only.db })));
    expect(ids(adaOnly)).toEqual([byAda.row.id]);
    expect(only.log.identityLookups).toBe(0);
    // A worker that did not ask: the rows name a user, so ONE lookup, and the same user's rows still match by identity.
    const mismatched = observedDb();
    const asBob = await asWorker('worker-bob', () => Q.questions(null, { logRef: logA.row.id, askedByMe: true }, as(writer.id, { db: mismatched.db })));
    expect(idSet(asBob)).toEqual([byAda.row.id, byBob.row.id].sort());
    expect(mismatched.log.identityLookups).toBe(1);
    // An App-only caller (no user): no lookup, and it finds only its own App-asked rows.
    const key = { db, appId: app.id, appKeyId: generateId(), roles: ['ADMIN'] } as Context;
    await db.memory.update({ where: { id: memA.id }, data: { class: 'app' } });
    const appAsked = await M.askQuestion(null, { logRef: logA.row.id, input: simple() }, key);
    const keyObserved = observedDb();
    const mine = await Q.questions(null, { logRef: logA.row.id, askedByMe: true }, { ...key, db: keyObserved.db } as Context);
    expect(ids(mine)).toEqual([appAsked.row.id]);
    expect(keyObserved.log.identityLookups).toBe(0);
  });

  it('an identity alias still counts: the account merged into the caller\'s is the asker', async () => {
    const q = await ask(logA.row.id, simple(), holger.id);
    await M.mergeUsers(null, { input: { source: holger.id, target: kay.id, consentProof: await approvedMergeProof(db, holger.id, kay.id, platformAdmin.id) } },
      as(platformAdmin.id, { roles: ['ADMIN'] }));
    const observed = observedDb();
    const page = await Q.questions(null, { logRef: logA.row.id, askedByMe: true }, as(kay.id, { db: observed.db }));
    expect(ids(page)).toEqual([q.row.id]);
    expect(observed.log.identityLookups).toBe(1);
  });
});

