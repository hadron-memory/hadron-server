/**
 * #3422 (hrn:node:hadronmemory.com:specs:cor:agt:120:03, r14): the no-team filter on `untrackedTaskItems`,
 * `claimUntrackedTaskItems` and the run tools `hadron_task_untracked_list` / `hadron_task_untracked_claim`.
 *
 * GitHub is faked at `fetch` (the #2485 seam), as in untrackedTaskItems3125.test.ts, and `calls` counts every tracker
 * request including the token mint, so "no tracker read" means no request of any kind. The controls run through real
 * GraphQL documents: an argument the schema does not declare is a validation error, so they are red until `noTeam`
 * exists, and they prove what the argument's false, null and omitted forms do on the wire.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolveRunTools } from '../../../lib/runner/tools/index.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from '../../../lib/runner/tools/types.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const INSTALLATION_ID = 342203;
const TOKEN = 'ghs_SYNTHETIC3422tokenNEVERreal000000000000';
const APP_KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

// --- fake GitHub ----------------------------------------------------------------------------

type Issue = { number: number; labels: string[]; prs?: boolean[]; labelsTruncated?: boolean };
let repos: Record<string, Issue[]>;
let calls: number;
let gate: Promise<void> | null;
let reads: number;

const url = (repo: string, n: number) => `https://github.com/acme/${repo}/issues/${n}`;

async function fakeFetch(u: string | URL, init?: RequestInit): Promise<Response> {
  const target = String(u);
  calls++;
  if (target.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      token: TOKEN, expires_at: '2026-11-04T23:00:00Z', permissions: body.permissions,
      repository_selection: 'selected', repositories: body.repositories.map((n: string) => ({ id: 1, full_name: `acme/${n}` })),
    }), { status: 201 });
  }
  if (target === 'https://api.github.com/graphql') {
    reads++;
    if (gate) await gate;
    const { name } = JSON.parse(String(init?.body)).variables as { name: string };
    return new Response(JSON.stringify({
      data: { repository: { issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: (repos[name] ?? []).map((i) => ({
          number: i.number, title: `${name} issue ${i.number}`, url: url(name, i.number),
          createdAt: `2026-10-${String(i.number).padStart(2, '0')}T10:00:00Z`, updatedAt: '2026-10-30T10:00:00Z',
          labels: { nodes: i.labels.map((l) => ({ name: l })), pageInfo: { hasNextPage: i.labelsTruncated === true } },
          closedByPullRequestsReferences: { nodes: (i.prs ?? []).map((merged) => ({ merged })), pageInfo: { hasNextPage: false } },
        })),
      } } },
    }), { status: 200 });
  }
  return new Response('unexpected url', { status: 599 });
}

// --- fixtures -------------------------------------------------------------------------------

let org: any, app: any, otherApp: any, agentId: string;
let member: any, member2: any, outsider: any, anne: any, liam: any, keyX: any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const keyCtx = (appId: string, appKeyId: string): Context => ({ db, appId, appKeyId, roles: [] });
const list = (args: Record<string, unknown> = {}, c: Context = ctx(member.id)) =>
  Q.untrackedTaskItems({}, { appRef: app.id, integration: 'gh', ...args }, c);
const claim = (args: Record<string, unknown> = {}, c: Context = ctx(member.id)) =>
  M.claimUntrackedTaskItems({}, { appRef: app.id, integration: 'gh', ...args }, c);
const numbers = (r: { items: Array<{ number: number }> }) => r.items.map((i) => i.number);
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return { message: e?.message as string, code: e?.extensions?.code as string }; }
  throw new Error('expected a refusal');
};
const claimedCount = () => db.agentTask.count({ where: { appId: app.id, externalId: { not: null } } });

async function mintRun(forApp = app.id, extra: Record<string, unknown> = {}): Promise<AppRun> {
  return db.appRun.create({
    data: { id: generateId(), organizationId: org.id, appId: forApp, triggerKind: 'MANUAL', entryNodeUrn: 'ut-org::mem::flow:entry', status: 'RUNNING', ...extra },
  });
}
const toolCtx = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
const tool = (name: string) => resolveRunTools([name]).tools.find((t) => t.name === name)!;
const runList = async (args: Record<string, unknown>, run?: AppRun): Promise<any> => {
  return tool('hadron_task_untracked_list').execute(toolCtx(run ?? await mintRun()), { integration: 'gh', ...args });
};
const runClaim = async (args: Record<string, unknown>, run?: AppRun): Promise<any> => {
  return tool('hadron_task_untracked_claim').execute(toolCtx(run ?? await mintRun()), { integration: 'gh', assignee: { worker: anne.id }, owner: { user: member.id }, ...args });
};

const INTEGRATION = (over: Record<string, unknown> = {}) => ({
  name: 'gh', provider: 'github', repositories: ['acme/widgets'], readyLabel: 'ready', excludeLabels: ['wontfix'],
  teams: [{ lead: anne.id, label: 'team-a' }, { lead: liam.id, label: 'team-b' }], ...over,
});
const setIntegration = (over: Record<string, unknown>) =>
  db.app.update({ where: { id: app.id }, data: { properties: { taskIntegrations: [INTEGRATION(over)] } as never } });
const withoutTeams = () => {
  const { teams: _teams, ...rest } = INTEGRATION();
  return db.app.update({ where: { id: app.id }, data: { properties: { taskIntegrations: [rest] } as never } });
};

/** Acceptance 1's five items, the team-labelled ones oldest. */
const FIVE = (): Issue[] => [
  { number: 1, labels: ['team-a'] },
  { number: 2, labels: ['team-b'] },
  { number: 3, labels: ['team-a', 'team-b'] },
  { number: 4, labels: ['bug'] },
  { number: 5, labels: [] },
];

beforeEach(async () => {
  await cleanDb(db);
  repos = { widgets: FIVE() };
  calls = 0;
  reads = 0;
  gate = null;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubEnv('GITHUB_APP_ID', '3422300');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', APP_KEY_PEM);

  const suffix = generateId().slice(-8);
  org = await db.organization.create({ data: { name: 'ut', urn: `ut34-${suffix}.test`, githubInstallationId: INSTALLATION_ID } });
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: org.id } })).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  [member, member2, outsider] = await Promise.all(['m1', 'm2', 'out'].map((h) => db.user.create({ data: { handle: `ut3422-${h}-${suffix}` } })));
  for (const u of [member, member2]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: outsider.id, role: 'member' } });
  const worker = (name: string) => db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: member.id, heldAt: new Date() },
    select: { id: true },
  });
  anne = await worker('Anne');
  liam = await worker('Liam');
  keyX = await db.appKey.create({ data: { appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
  await db.app.update({ where: { id: app.id }, data: { properties: { taskIntegrations: [INTEGRATION()] } as never } });
  await db.app.update({ where: { id: otherApp.id }, data: { properties: { taskIntegrations: [{ name: 'gh-other', provider: 'github', repositories: ['acme/widgets'] }] } as never } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** One real GraphQL document against the real schema, as a person. */
async function wire<T>(fn: (run: (query: string, variables?: Record<string, unknown>) => Promise<{ data?: any; errors?: any[] }>) => Promise<T>): Promise<T> {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  await api.start();
  try {
    return await fn(async (query, variables = {}) => {
      const r = await api.executeOperation({ query, variables: { a: app.id, ...variables } }, { contextValue: ctx(member.id) });
      if (r.body.kind !== 'single') throw new Error('unexpected body');
      return r.body.singleResult as { data?: any; errors?: any[] };
    });
  } finally {
    await api.stop();
  }
}
const LIST = 'total items{number}';

/** Inside Vitest's 5 s test budget, with room left to release the gate and settle the claims. */
const BARRIER_MS = 3_000;
/**
 * Hold concurrent claims at the tracker until `want` reads have arrived, then let them go. Two things end the wait
 * early, so a broken claim reports its own failure rather than the framework's timeout (#3447): a claim settling, and
 * the bound. `release` always runs, and the claims are settled before this returns, so none outlives its test. The bound
 * covers arrival at the tracker only: a claim that hangs after release still runs to the framework's timeout.
 */
async function holdAtTracker(claims: Array<Promise<unknown>>, release: () => void, want = 2, boundMs = BARRIER_MS) {
  let settled = false;
  const mark = () => { settled = true; };
  for (const c of claims) c.then(mark, mark);
  try {
    const by = Date.now() + boundMs;
    while (reads < want && !settled) {
      if (Date.now() > by) throw new Error(`barrier: ${reads} of ${want} tracker reads after ${boundMs} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    release();
    await Promise.allSettled(claims);
  }
}

describe('the no-team filter lists what carries no team label (cor:agt:120:03)', () => {
  it('keeps exactly the bug-only and unlabelled items, oldest first, and the total counts only them', async () => {
    const r = await list({ noTeam: true });
    expect(numbers(r)).toEqual([4, 5]);
    expect(r.total).toBe(2);
    expect(r.complete).toBe(true);
  });

  it('matches team labels without regard to case; a label outside the map is an ordinary label', async () => {
    repos.widgets = [{ number: 1, labels: ['TEAM-A'] }, { number: 2, labels: ['Team-B', 'bug'] }, { number: 3, labels: ['team-zed'] }];
    const r = await list({ noTeam: true });
    expect(numbers(r)).toEqual([3]);
    expect(r.total).toBe(1);
  });

  it('pages over the filtered list: a page never holds a team-labelled item and skip counts filtered items', async () => {
    repos.widgets = [
      { number: 1, labels: ['team-a'] }, { number: 2, labels: [] }, { number: 3, labels: ['team-b'] },
      { number: 4, labels: ['bug'] }, { number: 5, labels: ['team-a'] }, { number: 6, labels: [] },
    ];
    const first = await list({ noTeam: true, skip: 0, limit: 2 });
    const second = await list({ noTeam: true, skip: 2, limit: 2 });
    expect(numbers(first)).toEqual([2, 4]);
    expect(numbers(second)).toEqual([6]);
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
  });

  it.each([
    ['no teams key', withoutTeams],
    ['an empty team map', () => setIntegration({ teams: [] })],
  ])('with %s every item the other filters admit qualifies', async (_name, arrange) => {
    await arrange();
    repos.widgets = [...FIVE(), { number: 6, labels: ['wontfix'] }];
    const r = await list({ noTeam: true });
    expect(numbers(r)).toEqual([1, 2, 3, 4, 5]);
    expect(r.total).toBe(5);
  });

  it('composes with ready, repository, the exclude labels, the tracked rule and the merged flag', async () => {
    await setIntegration({ repositories: ['acme/widgets', 'acme/gadgets'] });
    repos.widgets = [
      { number: 1, labels: ['ready', 'team-a'] }, { number: 2, labels: ['ready'], prs: [true] }, { number: 3, labels: [] },
      { number: 4, labels: ['wontfix'] }, { number: 5, labels: [] },
    ];
    repos.gadgets = [{ number: 6, labels: ['ready'] }];
    await db.agentTask.create({ data: { appId: app.id, title: 'held', externalId: url('widgets', 5), ownerUserId: member.id, status: 'pending' } });

    expect(numbers(await list({ noTeam: true }))).toEqual([2, 3, 6]);
    const only = await list({ noTeam: true, ready: 'ONLY' });
    expect(numbers(only)).toEqual([2, 6]);
    expect(only.items[0].linkedPullRequestMerged).toBe(true);
    expect(numbers(await list({ noTeam: true, ready: 'EXCLUDE' }))).toEqual([3]);
    expect(numbers(await list({ noTeam: true, repository: 'acme/gadgets' }))).toEqual([6]);
  });

  it('leaves out an item whose labels ran past the page read: it might carry a team label, so the list says incomplete', async () => {
    repos.widgets = [{ number: 1, labels: ['bug'], labelsTruncated: true }, { number: 2, labels: [] }];
    const r = await list({ noTeam: true });
    expect(numbers(r)).toEqual([2]);
    expect(r).toMatchObject({ complete: false, incompleteReason: 'item_truncated' });
  });
});

describe('the no-team filter claims (cor:agt:120:03, S2)', () => {
  it('limit 2 takes the two oldest team-less items, never an older team-labelled one, created started', async () => {
    repos.widgets = [...FIVE(), { number: 6, labels: [] }];
    const r = await claim({ noTeam: true, limit: 2 });
    expect(r.tasks.map((t: any) => t.externalId)).toEqual([url('widgets', 4), url('widgets', 5)]);
    expect(r.tasks.map((t: any) => t.status)).toEqual(['started', 'started']);
    expect(await claimedCount()).toBe(2);
  });

  it('a short result is not an error: only team-labelled items left claims nothing', async () => {
    repos.widgets = [{ number: 1, labels: ['team-a'] }];
    const r = await claim({ noTeam: true, limit: 2 });
    expect(r).toMatchObject({ tasks: [], complete: true, incompleteReason: null, refusalCode: null });
    expect(await claimedCount()).toBe(0);
  });

  it('two concurrent claims take disjoint sets and never a team-labelled item', async () => {
    repos.widgets = [
      { number: 1, labels: ['team-a'] }, { number: 2, labels: ['team-b'] },
      { number: 3, labels: [] }, { number: 4, labels: ['bug'] }, { number: 5, labels: [] }, { number: 6, labels: ['team-zed'] },
    ];
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const a = claim({ noTeam: true, limit: 2 }, ctx(member.id));
    const b = claim({ noTeam: true, limit: 2 }, ctx(member2.id));
    // Both callers must hold the same pre-claim list, or the skip path never runs.
    await holdAtTracker([a, b], release);
    const [ra, rb] = await Promise.all([a, b]);
    expect(reads).toBe(2);
    const ia: string[] = ra.tasks.map((t: any) => t.externalId);
    const ib: string[] = rb.tasks.map((t: any) => t.externalId);
    expect(ia).toHaveLength(2);
    expect(ib).toHaveLength(2);
    expect(ia.filter((x) => ib.includes(x))).toEqual([]);
    expect([...ia, ...ib].sort()).toEqual([3, 4, 5, 6].map((n) => url('widgets', n)));
    expect(await claimedCount()).toBe(4);
  });

  it('the barrier ends when a claim fails first, so the failure is the claim\'s own', async () => {
    let released = false;
    const failed = Promise.reject(new Error('the claim\'s own failure'));
    await holdAtTracker([failed], () => { released = true; });
    expect(released).toBe(true);
    await expect(failed).rejects.toThrow('the claim\'s own failure');
  });

  it('the barrier gives up at its bound, naming the shortfall, and still releases the gate', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await expect(holdAtTracker([held], release, 2, 20)).rejects.toThrow('barrier: 0 of 2 tracker reads after 20 ms');
    await expect(held).resolves.toBeUndefined();
  });

  it('the default bound fires inside the test budget, so it is the barrier that reports, not the framework', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await expect(holdAtTracker([held], release)).rejects.toThrow(`barrier: 0 of 2 tracker reads after ${BARRIER_MS} ms`);
    await expect(held).resolves.toBeUndefined();
  });

  it("the App's own key claims with it, for the parties it names", async () => {
    const r = await claim({ noTeam: true, limit: 1, assignee: { worker: anne.id }, owner: { user: member.id } }, keyCtx(app.id, keyX.id));
    expect(r.tasks.map((t: any) => t.externalId)).toEqual([url('widgets', 4)]);
    expect(r.tasks[0]).toMatchObject({ status: 'started' });
  });
});

/** #3447: a team map may be written with capitals, and an item's label may be cased either way. */
const CAPITAL_MAP = () => setIntegration({ teams: [{ lead: anne.id, label: 'Team-A' }, { lead: liam.id, label: 'TEAM-B' }] });
const CAPITAL_ITEMS = (): Issue[] => [
  { number: 1, labels: ['team-a'] },
  { number: 2, labels: ['Team-A', 'bug'] },
  { number: 3, labels: ['TEAM-B'] },
  { number: 4, labels: ['team-b'] },
  { number: 5, labels: ['bug'] },
  { number: 6, labels: [] },
];

describe('a team map written with capitals (cor:agt:120:01, :03)', () => {
  beforeEach(async () => {
    await CAPITAL_MAP();
    repos.widgets = CAPITAL_ITEMS();
  });

  it('the list keeps out every cased form of a team label', async () => {
    const r = await list({ noTeam: true });
    expect(numbers(r)).toEqual([5, 6]);
    expect(r.total).toBe(2);
  });

  it('a no-team claim takes no team-labelled item, however old', async () => {
    const r = await claim({ noTeam: true, limit: 6 });
    expect(r.tasks.map((t: any) => t.externalId)).toEqual([url('widgets', 5), url('widgets', 6)]);
    expect(await claimedCount()).toBe(2);
  });

  it('the run tools answer the same', async () => {
    expect(numbers(await runList({ noTeam: true }))).toEqual([5, 6]);
    expect(claimedUrls(await runClaim({ noTeam: true }))).toEqual([url('widgets', 5)]);
  });

  it("a team filter still finds its own items: the map's capitals do not hide them", async () => {
    expect(numbers(await list({ team: anne.id }))).toEqual([1, 2]);
    expect(numbers(await list({ team: liam.id }))).toEqual([3, 4]);
  });
});

/** Every entry point that takes the filter, as one table: the same inputs must answer the same on each. */
const SURFACES: Array<[string, (args: Record<string, unknown>) => Promise<any>]> = [
  ['the GraphQL list', (args) => list(args)],
  ['the GraphQL claim', (args) => claim(args)],
  ['the run list tool', (args) => runList(args)],
  ['the run claim tool', (args) => runClaim(args)],
];
const claimedUrls = (r: any): string[] =>
  r.task !== undefined ? (r.task ? [r.task.externalId] : []) : (r.tasks ?? []).map((t: any) => t.externalId);

describe('refusing the filter with a team (cor:agt:120:03)', () => {
  describe.each(SURFACES)('on %s', (_name, surface) => {
    it('noTeam with a real team is BAD_USER_INPUT: no tracker request, no task', async () => {
      const r = await refusal(surface({ noTeam: true, team: anne.id }));
      expect(r.code).toBe('BAD_USER_INPUT');
      expect(calls).toBe(0);
      expect(await claimedCount()).toBe(0);
    });

    it('a blank team counts as supplied: BAD_USER_INPUT, not TASK_INTEGRATION_TEAM_UNKNOWN', async () => {
      const r = await refusal(surface({ noTeam: true, team: '' }));
      expect(r.code).toBe('BAD_USER_INPUT');
      expect(calls).toBe(0);
      expect(await claimedCount()).toBe(0);
    });

    it('a team that names nobody is BAD_USER_INPUT too: the combination is judged, not the team', async () => {
      const r = await refusal(surface({ noTeam: true, team: 'nobody-at-all' }));
      expect(r.code).toBe('BAD_USER_INPUT');
      expect(calls).toBe(0);
    });

    it('an unknown integration still answers as unknown, first', async () => {
      const r = await refusal(surface({ integration: 'nope', noTeam: true, team: anne.id }));
      expect(r.code).toBe('TASK_INTEGRATION_NOT_FOUND');
      expect(calls).toBe(0);
    });
  });
});

describe('a run tool refuses a team that is not text (#3471, cor:agt:120:03)', () => {
  // A tool's arguments reach execute() as the model wrote them. A team that read as absent would turn a claim for one
  // lane into an unfiltered one, handing out another lane's item.
  const MESSAGE = 'team must be a worker id, URN or name.';
  const allTasks = () => db.agentTask.count({ where: { appId: app.id } });

  describe.each([
    ['the run list tool', runList],
    ['the run claim tool', runClaim],
  ])('on %s', (_name, surface) => {
    it.each([[5], [0], [true], [false], [{}], [[]], [['team-a']], [{ toString: null }]])('team %j is BAD_USER_INPUT with fixed text: no tracker request, no task', async (team) => {
      const r = await refusal(surface({ team }));
      expect(r).toEqual({ code: 'BAD_USER_INPUT', message: MESSAGE });
      expect(calls).toBe(0);
      expect(await allTasks()).toBe(0);
    });

    it.each([[false], [null]])('noTeam %j does not excuse it', async (noTeam) => {
      expect(await refusal(surface({ noTeam, team: 5 }))).toEqual({ code: 'BAD_USER_INPUT', message: MESSAGE });
      expect(calls).toBe(0);
    });

    it('with noTeam true, "not both" still wins', async () => {
      expect(await refusal(surface({ noTeam: true, team: 5 }))).toEqual({ code: 'BAD_USER_INPUT', message: 'Ask for no team or for a team, not both.' });
      expect(calls).toBe(0);
    });

    it('a malformed noTeam is judged first', async () => {
      expect(await refusal(surface({ noTeam: 'true', team: 5 }))).toEqual({ code: 'BAD_USER_INPUT', message: 'noTeam must be true or false.' });
    });

    it('a blank team keeps TASK_INTEGRATION_TEAM_UNKNOWN', async () => {
      expect((await refusal(surface({ team: '' }))).code).toBe('TASK_INTEGRATION_TEAM_UNKNOWN');
      expect((await refusal(surface({ team: '   ' }))).code).toBe('TASK_INTEGRATION_TEAM_UNKNOWN');
      expect(calls).toBe(0);
    });

    it('a finished run, an unknown integration and an unconnected repository each answer first', async () => {
      const run = await mintRun(app.id, { status: 'COMPLETED' });
      expect((await refusal(surface({ team: 5 }, run))).code).toBe('APP_NOT_FOUND');
      expect((await refusal(surface({ integration: 'nope', team: 5 }))).code).toBe('TASK_INTEGRATION_NOT_FOUND');
      expect((await refusal(surface({ repository: 'acme/other', team: 5 }))).code).toBe('TASK_INTEGRATION_REPOSITORY_NOT_CONNECTED');
      expect(calls).toBe(0);
    });

    it("a run of another App naming this App is APP_NOT_FOUND, not the team's refusal", async () => {
      const run = await mintRun(otherApp.id);
      expect((await refusal(surface({ appRef: app.id, team: 5 }, run))).code).toBe('APP_NOT_FOUND');
      expect(calls).toBe(0);
    });
  });

  it.each([['absent', {}], ['null', { team: null }]])('a %s team stays no filter', async (_name, form) => {
    expect(numbers(await runList(form))).toEqual([1, 2, 3, 4, 5]);
    expect(claimedUrls(await runClaim(form))).toEqual([url('widgets', 1)]);
  });

  it('a team named as text still filters, by id and with spaces around it', async () => {
    expect(numbers(await runList({ team: anne.id }))).toEqual([1, 3]);
    expect(numbers(await runList({ team: ` ${liam.id} ` }))).toEqual([2, 3]);
    expect(claimedUrls(await runClaim({ team: liam.id }))).toEqual([url('widgets', 2)]);
  });

  it('GraphQL is not touched: an ID argument arrives as text, so a number there is an unknown team', async () => {
    await wire(async (run) => {
      const r = await run(`query($a:ID!){untrackedTaskItems(appRef:$a,integration:"gh",team:5){${LIST}}}`);
      expect(r.errors?.[0]?.extensions?.code).toBe('TASK_INTEGRATION_TEAM_UNKNOWN');
    });
    expect(calls).toBe(0);
  });
});

describe('the run tools take no malformed form of the filter (their arguments are not schema-checked)', () => {
  // GraphQL refuses these at validation; a model's tool call reaches execute() as written. A value that read as absent
  // would turn a no-team claim into an unfiltered one, taking another lane's item.
  describe.each([
    ['the run list tool', runList],
    ['the run claim tool', runClaim],
  ])('on %s', (_name, surface) => {
    it.each([['true'], ['false'], [1], [0], [{}]])('noTeam %j is BAD_USER_INPUT, no tracker request, no task', async (noTeam) => {
      const r = await refusal(surface({ noTeam }));
      expect(r.code).toBe('BAD_USER_INPUT');
      expect(calls).toBe(0);
      expect(await claimedCount()).toBe(0);
    });

    it('a non-string team beside noTeam counts as supplied: BAD_USER_INPUT', async () => {
      const r = await refusal(surface({ noTeam: true, team: 7 }));
      expect(r.code).toBe('BAD_USER_INPUT');
      expect(calls).toBe(0);
    });

    it('a finished run is APP_NOT_FOUND before any argument is judged', async () => {
      const run = await mintRun(app.id, { status: 'COMPLETED' });
      const r = await refusal(surface({ noTeam: 'true', team: anne.id }, run));
      expect(r.code).toBe('APP_NOT_FOUND');
      expect(calls).toBe(0);
    });

    // Reachable from JSON: no string form exists, so converting the value throws. That must not happen before the gate.
    it.each([[{ toString: null }], [[{ toString: null }]]])('a team %j that has no string form is the same refusal', async (team) => {
      const r = await refusal(surface({ noTeam: true, team }));
      expect(r.code).toBe('BAD_USER_INPUT');
      expect(calls).toBe(0);
      expect(await claimedCount()).toBe(0);
    });

    it('a finished run answers APP_NOT_FOUND for a team with no string form too', async () => {
      const run = await mintRun(app.id, { status: 'COMPLETED' });
      const r = await refusal(surface({ noTeam: true, team: { toString: null } }, run));
      expect(r.code).toBe('APP_NOT_FOUND');
      expect(calls).toBe(0);
    });
  });
});

describe('omitted, false and null are no filter on the run tools (cor:agt:120:03)', () => {
  describe.each([
    ['omitted', {}],
    ['false', { noTeam: false }],
    ['null', { noTeam: null }],
  ])('noTeam %s', (_name, form) => {
    it('the run list lists every lane, and a team filter stands', async () => {
      expect(numbers(await runList(form))).toEqual([1, 2, 3, 4, 5]);
      expect(numbers(await runList({ ...form, team: anne.id }))).toEqual([1, 3]);
    });

    it('the run claim takes the oldest item of any lane', async () => {
      expect(claimedUrls(await runClaim(form))).toEqual([url('widgets', 1)]);
    });

    it("the run claim keeps to a team's lane", async () => {
      expect(claimedUrls(await runClaim({ ...form, team: liam.id }))).toEqual([url('widgets', 2)]);
    });
  });
});

describe('run parity and the App boundary (cor:agt:120:03, V38)', () => {
  it("a run of the App lists exactly GraphQL's page", async () => {
    const graphql = await list({ noTeam: true });
    const viaRun = await runList({ noTeam: true });
    expect(numbers(viaRun)).toEqual([4, 5]);
    expect(viaRun.total).toBe(graphql.total);
    expect(viaRun.items).toEqual(graphql.items);
  });

  it('the run claim takes the oldest team-less item, one per call, then the next', async () => {
    const run = await mintRun();
    const first = await runClaim({ noTeam: true }, run);
    const second = await runClaim({ noTeam: true }, run);
    const third = await runClaim({ noTeam: true }, run);
    expect([first, second].flatMap(claimedUrls)).toEqual([url('widgets', 4), url('widgets', 5)]);
    expect(first.task.status).toBe('started');
    expect(third.task).toBeNull();
    expect(await claimedCount()).toBe(2);
  });

  it("a run of another App naming this App's integration answers as missing; naming this App is APP_NOT_FOUND", async () => {
    const run = await mintRun(otherApp.id);
    expect((await refusal(runList({ noTeam: true }, run))).code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect((await refusal(runClaim({ noTeam: true }, run))).code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect((await refusal(runList({ noTeam: true, appRef: app.id }, run))).code).toBe('APP_NOT_FOUND');
    expect((await refusal(runClaim({ noTeam: true, appRef: app.id }, run))).code).toBe('APP_NOT_FOUND');
    expect(calls).toBe(0);
    expect(await claimedCount()).toBe(0);
  });

  it('someone outside the App is APP_NOT_FOUND with the filter too, and another App has no such integration', async () => {
    expect((await refusal(list({ noTeam: true }, ctx(outsider.id)))).code).toBe('APP_NOT_FOUND');
    expect((await refusal(claim({ noTeam: true }, ctx(outsider.id)))).code).toBe('APP_NOT_FOUND');
    expect((await refusal(list({ appRef: otherApp.id, noTeam: true }, ctx(outsider.id)))).code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect(calls).toBe(0);
  });
});

describe('the argument on the wire (cor:agt:120:03)', () => {
  it('omitted, false and null leave the team filter and the unfiltered list as they are', async () => {
    await wire(async (run) => {
      const unfiltered = [1, 2, 3, 4, 5];
      for (const arg of ['', ',noTeam:false', ',noTeam:null']) {
        const open = await run(`query($a:ID!){untrackedTaskItems(appRef:$a,integration:"gh"${arg}){${LIST}}}`);
        expect(open.errors).toBeUndefined();
        expect(numbers(open.data.untrackedTaskItems)).toEqual(unfiltered);
        const team = await run(`query($a:ID!,$t:ID){untrackedTaskItems(appRef:$a,integration:"gh",team:$t${arg}){${LIST}}}`, { t: anne.id });
        expect(team.errors).toBeUndefined();
        expect(numbers(team.data.untrackedTaskItems)).toEqual([1, 3]);
      }
    });
  });

  it('omitted, false and null keep the team filter on the claim too, and take the oldest of any lane without one', async () => {
    await wire(async (run) => {
      for (const arg of ['', ',noTeam:false', ',noTeam:null']) {
        const r = await run(`mutation($a:ID!,$t:ID){claimUntrackedTaskItems(appRef:$a,integration:"gh",team:$t${arg},limit:1){tasks{externalId}}}`, { t: liam.id });
        expect(r.errors).toBeUndefined();
        expect(r.data.claimUntrackedTaskItems.tasks).toEqual([{ externalId: url('widgets', 2) }]);
        const any = await run(`mutation($a:ID!){claimUntrackedTaskItems(appRef:$a,integration:"gh"${arg},limit:1){tasks{externalId}}}`);
        expect(any.errors).toBeUndefined();
        expect(any.data.claimUntrackedTaskItems.tasks).toEqual([{ externalId: url('widgets', 1) }]);
        await db.agentTask.deleteMany({ where: { appId: app.id } });
      }
    });
  });

  it('an explicit null team is not supplied: noTeam stands and is not refused', async () => {
    await wire(async (run) => {
      const r = await run(`query($a:ID!,$t:ID){untrackedTaskItems(appRef:$a,integration:"gh",team:$t,noTeam:true){${LIST}}}`, { t: null });
      expect(r.errors).toBeUndefined();
      expect(numbers(r.data.untrackedTaskItems)).toEqual([4, 5]);
    });
  });

  it('noTeam with a team through a real document is BAD_USER_INPUT and reaches no tracker', async () => {
    await wire(async (run) => {
      for (const doc of [
        `query($a:ID!,$t:ID){untrackedTaskItems(appRef:$a,integration:"gh",team:$t,noTeam:true){${LIST}}}`,
        'mutation($a:ID!,$t:ID){claimUntrackedTaskItems(appRef:$a,integration:"gh",team:$t,noTeam:true){tasks{id}}}',
      ]) {
        const r = await run(doc, { t: anne.id });
        expect(r.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      }
    });
    expect(calls).toBe(0);
    expect(await claimedCount()).toBe(0);
  });

  it('the SDL describes what true does, what false or omitted keeps, and the refusal, on both operations', () => {
    const sdl = typeDefs as unknown as string;
    for (const field of ['untrackedTaskItems', 'claimUntrackedTaskItems']) {
      const at = sdl.indexOf(`${field}(appRef`);
      expect(at).toBeGreaterThan(0);
      const signature = sdl.slice(at, sdl.indexOf('\n', at));
      expect(signature).toContain('noTeam: Boolean');
    }
    expect(sdl).toMatch(/noTeam[^"]*none of the integration's team labels/);
    expect(sdl).toMatch(/noTeam[^"]*false or omitted/i);
    expect(sdl).toMatch(/noTeam[^"]*with team[^"]*BAD_USER_INPUT/);
  });
});
