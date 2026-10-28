import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });
// Admin context → getAccessibleMemoryIds returns null (all memories accessible).
const admin = () => ctx({ roles: ['ADMIN'], userId: 'admin-fn' });

const findNodes = (args: Record<string, unknown>, c: Context = admin()) =>
  (resolvers.Query as any).findNodes(null, args, c);

async function mkNode(memoryId: string, fields: Record<string, unknown>) {
  return db.node.create({ data: { id: generateId(), memoryId, ...fields } as any });
}

let orgA: { id: string };
let graph: { id: string };
let sysMem: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'fn-org', graphName: 'fn/graph' });
  orgA = made.org;
  graph = made.graph;
  const sys = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'fn-org:fn/system', name: 'fn/system', class: 'system' },
  });
  sysMem = { id: sys.id };
});

describe('findNodes — lexical ranking (cor:rag:010:02)', () => {
  it('ranks a name hit above the same term buried in a long body (the motivating case)', async () => {
    await mkNode(graph.id, { loc: 'fruit.banana', name: 'Banana smoothie', content: 'A short unrelated note.' });
    await mkNode(graph.id, {
      loc: 'fruit.filler',
      name: 'Grocery list',
      content: 'A long descriptive body about the weekly shop. ' + 'lorem ipsum dolor sit amet. '.repeat(80) + ' banana appears once here, buried.',
    });
    const res = await findNodes({ query: 'banana', mode: 'keyword' });
    expect(res.hits.length).toBe(2);
    expect(res.hits[0].node.loc).toBe('fruit.banana');
    expect(res.hits[0].score).toBeGreaterThan(res.hits[1].score);
  });

  it('fields weight-mask: restricting to name does not let a body-only hit rank', async () => {
    await mkNode(graph.id, { loc: 'n.name', name: 'banana', content: 'nothing here' });
    await mkNode(graph.id, { loc: 'n.body', name: 'Grocery', content: 'banana in the body' });
    const res = await findNodes({ query: 'banana', mode: 'keyword', fields: ['name'] });
    // Both may match (weight-mask is not a hard filter), but the name hit must
    // score > 0 and outrank the body-only hit (which scores ~0 under a name mask).
    const nameHit = res.hits.find((h: any) => h.node.loc === 'n.name');
    const bodyHit = res.hits.find((h: any) => h.node.loc === 'n.body');
    expect(nameHit.score).toBeGreaterThan(0);
    expect(nameHit.score).toBeGreaterThan(bodyHit?.score ?? 0);
  });
});

describe('findNodes — minScore relevance floor (#497)', () => {
  it('drops keyword hits scoring below the floor, keeps the strong ones', async () => {
    await mkNode(graph.id, { loc: 'm.strong', name: 'banana banana banana' });
    await mkNode(graph.id, {
      loc: 'm.weak',
      name: 'Grocery list',
      content: 'a long note that mentions banana just once, buried far in. ' + 'lorem ipsum. '.repeat(60),
    });
    const unfiltered = await findNodes({ query: 'banana', mode: 'keyword' });
    expect(unfiltered.hits.length).toBe(2);
    const weakScore = unfiltered.hits.find((h: any) => h.node.loc === 'm.weak').score;
    const strongScore = unfiltered.hits.find((h: any) => h.node.loc === 'm.strong').score;
    expect(strongScore).toBeGreaterThan(weakScore);

    // A floor between the two scores keeps only the strong hit.
    const floored = await findNodes({
      query: 'banana',
      mode: 'keyword',
      minScore: (weakScore + strongScore) / 2,
    });
    expect(floored.hits.map((h: any) => h.node.loc)).toEqual(['m.strong']);
  });

  it('a NaN / non-finite minScore is ignored (no floor applied)', async () => {
    await mkNode(graph.id, { loc: 'm.a', name: 'banana one' });
    await mkNode(graph.id, { loc: 'm.b', name: 'banana two' });
    const res = await findNodes({ query: 'banana', mode: 'keyword', minScore: Number.NaN });
    expect(res.hits.length).toBe(2);
  });

  it('minScore never filters the unscored no-query browse list', async () => {
    await mkNode(graph.id, { loc: 'l.a', name: 'alpha' });
    await mkNode(graph.id, { loc: 'l.b', name: 'beta' });
    const res = await findNodes({ minScore: 999 });
    expect(res.hits.length).toBe(2);
    expect(res.hits.every((h: any) => h.score === null)).toBe(true);
  });
});

describe('findNodes — boolean operators (cor:api:090:01)', () => {
  beforeEach(async () => {
    await mkNode(graph.id, { loc: 'b.bshake', name: 'Banana shake recipe' });
    await mkNode(graph.id, { loc: 'b.ashake', name: 'Apple shake recipe' });
    await mkNode(graph.id, { loc: 'b.bread', name: 'Banana bread' });
  });

  it('evaluates (banana OR apple) AND shake', async () => {
    const res = await findNodes({ query: '(banana OR apple) AND shake', mode: 'keyword' });
    const locs = res.hits.map((h: any) => h.node.loc).sort();
    expect(locs).toEqual(['b.ashake', 'b.bshake']);
  });

  it('degrades a malformed boolean query to a literal phrase search (no BAD_USER_INPUT)', async () => {
    // '(banana OR' is malformed boolean syntax. Instead of erroring, the
    // query runs as the literal phrase '"(banana OR"' — phraseto_tsquery
    // drops the punctuation/stopwords, so the banana fixtures still match —
    // and the envelope flags the degrade so a client can hint.
    const res = await findNodes({ query: '(banana OR', mode: 'keyword' });
    expect(res.degraded).toBe('literal_fallback');
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) expect(h.node.name.toLowerCase()).toContain('banana');
  });

  it('literal fallback still FINDS content when the typo query has real words', async () => {
    // An unterminated quote around a real phrase — the fallback searches the
    // words literally and hits.
    const res = await findNodes({ query: '"banana shake', mode: 'keyword' });
    expect(res.degraded).toBe('literal_fallback');
    expect(res.hits.map((h: any) => h.node.loc)).toContain('b.bshake');
  });

  it('operator words are UPPERCASE-ONLY — lowercase "banana or apple" is not a boolean OR', async () => {
    // Lowercase 'or' is a plain (stopword-ish) term, so the STRICT query is
    // banana AND or AND apple, which no fixture satisfies. That it takes #496
    // relaxation to surface anything is itself the proof 'or' was not treated
    // as a boolean operator — a real boolean OR would have matched at the
    // strict layer, with no relaxation flag.
    const res = await findNodes({ query: 'banana or apple', mode: 'keyword' });
    expect(res.degraded).toBe('and_relaxed_to_or');
    // The uppercase form IS the boolean expression — it matches at the strict
    // layer, unrelaxed.
    const upper = await findNodes({ query: '(banana OR apple) AND shake', mode: 'keyword' });
    expect(upper.degraded).toBeNull();
    expect(upper.hits.map((h: any) => h.node.loc).sort()).toEqual(['b.ashake', 'b.bshake']);
  });

  it('relaxes a bare conjunction to OR when it ANDs to zero (#496)', async () => {
    // 'banana' matches two fixtures; 'zucchini' matches none. Under strict AND
    // the whole query zeroes out; #496 retries as OR and flags the degrade.
    const res = await findNodes({ query: 'banana zucchini', mode: 'keyword' });
    expect(res.degraded).toBe('and_relaxed_to_or');
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) expect(h.node.name.toLowerCase()).toContain('banana');
  });

  it('relaxed results paginate — a deeper page still relaxes (#496, PR-571 review)', async () => {
    // 'banana OR zucchini' matches b.bshake + b.bread (2 hits). The strict
    // 'banana zucchini' is globally empty, so page 2 (offset 1) must still relax
    // and return the second relaxed hit, not an empty page.
    const p1 = await findNodes({ query: 'banana zucchini', mode: 'keyword', limit: 1, offset: 0 });
    const p2 = await findNodes({ query: 'banana zucchini', mode: 'keyword', limit: 1, offset: 1 });
    expect(p1.degraded).toBe('and_relaxed_to_or');
    expect(p2.degraded).toBe('and_relaxed_to_or');
    expect(p1.hits.length).toBe(1);
    expect(p2.hits.length).toBe(1);
    // Distinct nodes across the two relaxed pages.
    expect(p1.hits[0].node.loc).not.toBe(p2.hits[0].node.loc);
  });

  it('does NOT relax a page merely past the end of a matching set (#496, PR-571 review)', async () => {
    // 'banana shake' strictly matches exactly b.bshake. Requesting offset 1 is
    // past the end of a MATCHING query — it must return empty, NOT relax to OR.
    const res = await findNodes({ query: 'banana shake', mode: 'keyword', limit: 5, offset: 1 });
    expect(res.degraded).toBeNull();
    expect(res.hits).toEqual([]);
  });

  it('hybrid keyword-only fallback also relaxes AND-to-zero (#496, PR-571 review)', async () => {
    // The memory has no vector index, so mode:hybrid degrades to keyword-only.
    // That fallback must reach the same relaxation mode:keyword does, or hybrid
    // would be strictly weaker for a bare query. Both flags surface.
    const res = await findNodes({ query: 'banana zucchini', mode: 'hybrid' });
    expect(res.degraded).toBe('no_vector_index,and_relaxed_to_or');
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) expect(h.node.name.toLowerCase()).toContain('banana');
  });

  it('does NOT relax when the strict conjunction already matches (#496)', async () => {
    const res = await findNodes({ query: 'banana shake', mode: 'keyword' });
    expect(res.degraded).toBeNull();
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['b.bshake']);
  });

  it('does NOT relax when NO term matches — keeps the honest empty result (#496)', async () => {
    const res = await findNodes({ query: 'zucchini kohlrabi', mode: 'keyword' });
    expect(res.degraded).toBeNull();
    expect(res.hits).toEqual([]);
  });

  it('does NOT relax an explicit boolean query that matches nothing (#496)', async () => {
    // Explicit AND → the caller meant it; a zero result stays zero, unrelaxed.
    const res = await findNodes({ query: 'banana AND zucchini', mode: 'keyword' });
    expect(res.degraded).toBeNull();
    expect(res.hits).toEqual([]);
  });

  it('lowercase "not" does not negate — the "not sure" landmine', async () => {
    await mkNode(graph.id, { loc: 'b.sure', name: 'Sure-fire banana tips' });
    const res = await findNodes({ query: 'not sure', mode: 'keyword' });
    // Must NOT be interpreted as (NOT sure): a doc containing 'sure' is not
    // excluded. ('not' is an English stopword, so the query reduces to the
    // 'sure' term and the doc matches.)
    expect(res.hits.map((h: any) => h.node.loc)).toContain('b.sure');
  });

  it('hybrid on a non-indexed memory merges degrade flags: no_vector_index + literal_fallback', async () => {
    const res = await findNodes({ query: '(banana OR', mode: 'hybrid' });
    expect(res.degraded).toBe('no_vector_index,literal_fallback');
  });

  it('a quote-only query — where even the literalized form is empty — is zero hits, not an error (PR-482 review)', async () => {
    const kw = await findNodes({ query: '"', mode: 'keyword' });
    expect(kw.degraded).toBe('literal_fallback');
    expect(kw.hits).toEqual([]);
    const hy = await findNodes({ query: '"', mode: 'hybrid' });
    expect(hy.degraded).toBe('no_vector_index,literal_fallback');
    expect(hy.hits).toEqual([]);
  });

  it('mode: regex still fails loudly on bad syntax (explicit intent)', async () => {
    await expect(findNodes({ query: 'ban(ana', mode: 'regex' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('findNodes — regex mode', () => {
  it('matches by POSIX regex', async () => {
    await mkNode(graph.id, { loc: 'r.a', name: 'banana' });
    await mkNode(graph.id, { loc: 'r.b', name: 'bandana' });
    await mkNode(graph.id, { loc: 'r.c', name: 'orange' });
    const res = await findNodes({ query: 'ban.*na', mode: 'regex' });
    expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(['r.a', 'r.b']);
  });
});

describe('findNodes — regex fields are a score-mask, not a hard filter (cor:api:090:03)', () => {
  it('still returns a body-only regex match when fields=[name], just unscored', async () => {
    await mkNode(graph.id, { loc: 'rx.name', name: 'banana', content: 'x' });
    await mkNode(graph.id, { loc: 'rx.body', name: 'grocery', content: 'banana here' });
    const res = await findNodes({ query: 'banana', mode: 'regex', fields: ['name'] });
    const locs = res.hits.map((h: any) => h.node.loc).sort();
    expect(locs).toEqual(['rx.body', 'rx.name']); // both returned; fields only masks scoring
  });
});

describe('findNodes — sort + pagination on a query (applied in SQL, not after truncation)', () => {
  beforeEach(async () => {
    await mkNode(graph.id, { loc: 'srt.c', name: 'zeta gamma' });
    await mkNode(graph.id, { loc: 'srt.a', name: 'zeta alpha' });
    await mkNode(graph.id, { loc: 'srt.b', name: 'zeta beta' });
  });
  it('orders a keyword query by loc and pages correctly', async () => {
    const p1 = await findNodes({ query: 'zeta', mode: 'keyword', sort: 'loc', filter: { memoryIds: [graph.id] }, limit: 2, offset: 0 });
    expect(p1.hits.map((h: any) => h.node.loc)).toEqual(['srt.a', 'srt.b']);
    const p2 = await findNodes({ query: 'zeta', mode: 'keyword', sort: 'loc', filter: { memoryIds: [graph.id] }, limit: 2, offset: 2 });
    expect(p2.hits.map((h: any) => h.node.loc)).toEqual(['srt.c']);
  });
});

describe('findNodes — filtered list (query omitted, subsumes `nodes`)', () => {
  it('returns a deterministic list and excludes system-type nodes by default', async () => {
    await mkNode(graph.id, { loc: 'a.two', name: 'Two' });
    await mkNode(graph.id, { loc: 'a.one', name: 'One' });
    await mkNode(graph.id, { loc: 'a.sys', name: 'Sys', nodeType: 'system' });
    const res = await findNodes({ filter: { memoryIds: [graph.id] } });
    const locs = res.hits.map((h: any) => h.node.loc);
    expect(locs).toEqual(['a.one', 'a.two']); // loc-ordered, system-type excluded
    expect(res.hits.every((h: any) => h.score === null)).toBe(true); // unscored list
  });

  it('filters by isRunnable and locPrefix', async () => {
    await mkNode(graph.id, { loc: 'task.a', name: 'Task A', isRunnable: true });
    await mkNode(graph.id, { loc: 'task.b', name: 'Task B', isRunnable: false });
    await mkNode(graph.id, { loc: 'note.c', name: 'Note C', isRunnable: true });
    const res = await findNodes({ filter: { memoryIds: [graph.id], isRunnable: true, locPrefix: 'task.' } });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['task.a']);
  });

  it('filters a role family on dot boundaries, including every descendant depth', async () => {
    await mkNode(graph.id, { loc: 'r.base', name: 'base', role: 'spec' });
    await mkNode(graph.id, { loc: 'r.child', name: 'child', role: 'spec.rule' });
    await mkNode(graph.id, { loc: 'r.deep', name: 'deep', role: 'spec.rule.detail' });
    await mkNode(graph.id, { loc: 'r.special', name: 'special', role: 'special' });
    await mkNode(graph.id, { loc: 'r.specification', name: 'specification', role: 'specification' });
    await mkNode(graph.id, { loc: 'r.none', name: 'none', role: null });

    const spec = await findNodes({ filter: { memoryIds: [graph.id], role: 'spec' } });
    expect(spec.hits.map((h: any) => h.node.loc)).toEqual(['r.base', 'r.child', 'r.deep']);

    const rule = await findNodes({ filter: { memoryIds: [graph.id], role: 'spec.rule' } });
    expect(rule.hits.map((h: any) => h.node.loc)).toEqual(['r.child', 'r.deep']);
  });

  it('treats wildcard characters literally in an open-string role filter', async () => {
    await mkNode(graph.id, { loc: 'r.literal', name: 'literal', role: 'spec_rule' });
    await mkNode(graph.id, { loc: 'r.literal-child', name: 'child', role: 'spec_rule.child' });
    await mkNode(graph.id, { loc: 'r.wildcard-trap', name: 'trap', role: 'specXrule.child' });

    const res = await findNodes({ filter: { memoryIds: [graph.id], role: 'spec_rule' } });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['r.literal', 'r.literal-child']);
  });
});

describe('findNodes — structured filters apply to query results, not just lists', () => {
  it('respects isRunnable on a keyword query', async () => {
    await mkNode(graph.id, { loc: 'q.run1', name: 'runnable banana', isRunnable: true });
    await mkNode(graph.id, { loc: 'q.run2', name: 'another banana task', isRunnable: true });
    await mkNode(graph.id, { loc: 'q.note', name: 'banana note', isRunnable: false });
    const res = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryIds: [graph.id], isRunnable: true } });
    expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(['q.run1', 'q.run2']);
  });

  it('respects the dotted role family inside lexical SQL', async () => {
    await mkNode(graph.id, { loc: 'q.spec', name: 'banana base', role: 'spec' });
    await mkNode(graph.id, { loc: 'q.rule', name: 'banana rule', role: 'spec.rule' });
    await mkNode(graph.id, { loc: 'q.deep', name: 'banana detail', role: 'spec.rule.detail' });
    await mkNode(graph.id, { loc: 'q.other', name: 'banana other', role: 'special' });

    const res = await findNodes({
      query: 'banana',
      mode: 'keyword',
      filter: { memoryIds: [graph.id], role: 'spec.rule' },
    });
    expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(['q.deep', 'q.rule']);
  });

  it('excludes soft-deleted matches by default and includes them with includeDeleted', async () => {
    await mkNode(graph.id, { loc: 'd.live', name: 'live banana' });
    await mkNode(graph.id, { loc: 'd.dead', name: 'dead banana', deletedAt: new Date() });
    const def = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryIds: [graph.id] } });
    expect(def.hits.map((h: any) => h.node.loc)).toEqual(['d.live']);
    const inc = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryIds: [graph.id], includeDeleted: true } });
    expect(inc.hits.map((h: any) => h.node.loc).sort()).toEqual(['d.dead', 'd.live']);
  });
});

describe('findNodes — memoryClasses (cor:api:090:02)', () => {
  beforeEach(async () => {
    await mkNode(graph.id, { loc: 'k.node', name: 'knowledge banana' });
    await mkNode(sysMem.id, { loc: 's.node', name: 'system banana' });
  });

  it('excludes SYSTEM-class memories by default on a broad search', async () => {
    const res = await findNodes({ query: 'banana', mode: 'keyword' }); // no memoryIds → broad
    const locs = res.hits.map((h: any) => h.node.loc);
    expect(locs).toContain('k.node');
    expect(locs).not.toContain('s.node');
  });

  it('includes SYSTEM when explicitly requested via memoryClasses (explicit wins)', async () => {
    const res = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryClasses: ['system'] } });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['s.node']);
  });
});

describe('findNodes — orgId scope (#463); with filter.isRunnable = the tasks-in-one-org query', () => {
  it('narrows a member to one org; non-member org is empty; admin is ALSO membership-gated (no bypass)', async () => {
    // orgA (fn-org) already has `graph`; add a runnable node there.
    await mkNode(graph.id, { loc: 'org.taskA', name: 'Task A', isRunnable: true });
    // A second org with its own knowledge memory + runnable node.
    const b = await createDbOrgAndGraph(db, { orgName: 'fn-org-b', graphName: 'fnb/graph' });
    await mkNode(b.graph.id, { loc: 'org.taskB', name: 'Task B', isRunnable: true });

    // A user who is a member of orgA only.
    const member = await db.user.create({ data: { githubId: 6100, githubUsername: 'fn-member', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgA.id, userId: member.id, role: 'READER' } });
    const memberCtx = ctx({ userId: member.id, roles: [] });

    // Scoped to orgA (member) + isRunnable → only orgA's runnable node.
    const inA = await findNodes({ orgId: orgA.id, filter: { isRunnable: true } }, memberCtx);
    expect(inA.hits.map((h: any) => h.node.loc)).toEqual(['org.taskA']);

    // Scoped to orgB the caller is NOT a member of → empty (no existence disclosure).
    const inB = await findNodes({ orgId: b.org.id, filter: { isRunnable: true } }, memberCtx);
    expect(inB).toMatchObject({ hits: [], total: 0 });

    // Uniform member-only: `admin()` (admin-fn) is a member of no org, so even a
    // platform admin gets an empty page for orgB — no admin bypass.
    const adminB = await findNodes({ orgId: b.org.id, filter: { isRunnable: true } }, admin());
    expect(adminB).toMatchObject({ hits: [], total: 0 });

    // A real admin who IS a member of orgB can scope to it — membership, not the
    // platform role, is what authorizes the scope.
    const adminUser = await db.user.create({ data: { githubId: 6101, githubUsername: 'fn-admin', roles: ['ADMIN'] } });
    await db.orgMember.create({ data: { organizationId: b.org.id, userId: adminUser.id, role: 'READER' } });
    const adminMemberB = await findNodes(
      { orgId: b.org.id, filter: { isRunnable: true } },
      ctx({ userId: adminUser.id, roles: ['ADMIN'] }),
    );
    expect(adminMemberB.hits.map((h: any) => h.node.loc)).toEqual(['org.taskB']);
  });

  it('an App-key caller may scope to its own App org, but not another org', async () => {
    await mkNode(graph.id, { loc: 'app.task', name: 'App Task', isRunnable: true });
    // App in orgA + a session scoped to orgA's `graph` memory → App-key access.
    // #945: the session carries an installed agent that is LINKED to `graph`
    // (an AgentMemoryItem — the schema's "active write-memory for this session"
    // shape). This is scaffolding for the orgId-scope assertions below, and it
    // previously named a bare memoryId with no agent at all — a row production
    // cannot produce (`startAgentSession` is the only writer of
    // Session.memoryId and always sets agentId), and one the isolation branch
    // now correctly refuses to honor.
    const { app } = await createDbAppWithKey(db, 'fn-appkey', orgA.id);
    const agent = await db.agent.create({
      data: {
        id: generateId(), organizationId: orgA.id, urn: 'fn-org:fn-agent', name: 'fn agent',
        memoryItems: { create: [{ memoryId: graph.id, role: 'read' }] },
      },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId: agent.id, memoryId: graph.id },
    });
    const appCtx = ctx({ appId: app.id, sessionId: session.id });

    // Own org (orgA) → authorized; the session's memory is in orgA → its node shows.
    const own = await findNodes({ orgId: orgA.id, filter: { isRunnable: true } }, appCtx);
    expect(own.hits.map((h: any) => h.node.loc)).toEqual(['app.task']);

    // A different org → gate rejects (empty), no disclosure.
    const other = await createDbOrgAndGraph(db, { orgName: 'fn-other', graphName: 'other/graph' });
    const cross = await findNodes({ orgId: other.org.id, filter: { isRunnable: true } }, appCtx);
    expect(cross).toMatchObject({ hits: [], total: 0 });
  });
});

it('#2421 shared hybrid keyword extraction preserves independent degraded envelopes across calls', async () => {
  await db.memory.update({where:{id:graph.id},data:{vectorIndexEnabled:false}});
  await mkNode(graph.id, {loc:'extraction.banana',name:'banana shake'});
  for (const [query, degraded] of [
    ['banana zucchini', 'no_vector_index,and_relaxed_to_or'],
    ['(banana OR', 'no_vector_index,literal_fallback'],
    ['banana', 'no_vector_index'],
  ]) {
    const result = await findNodes({query,mode:'hybrid',filter:{memoryIds:[graph.id]}});
    expect(result.degraded).toBe(degraded);
  }
});
