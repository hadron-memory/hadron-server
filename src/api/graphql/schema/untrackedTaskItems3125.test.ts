/**
 * #3125 S3 (hrn:node:hadronmemory.com:specs:cor:agt:120:03; plan
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:plans:server-3125-task-integrations §S3): the untracked items of an
 * App's task integration, and claiming them.
 *
 * GitHub is faked at `fetch` (the #2485 seam): the installation-token mint and the GraphQL endpoint. The token is
 * synthetic and must never surface in a result, a refusal or a log line.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const INSTALLATION_ID = 312503;
const TOKEN = 'ghs_SYNTHETIC3125tokenNEVERreal000000000000';
const { privateKey: APP_KEY_PEM } = (() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string };
})();

// --- fake GitHub ----------------------------------------------------------------------------

type Issue = {
  number: number; title: string; url: string; createdAt: string; updatedAt: string; state: 'OPEN' | 'CLOSED';
  labels: string[]; prs: boolean[];
  /** GitHub reports more labels / closing pull requests than the one page read. */
  labelsTruncated?: boolean; prsTruncated?: boolean;
};
interface Fake {
  repos: Record<string, Issue[]>;
  pageSize: number;
  mintStatus: number;
  rateLimitOn: string | null;
  mints: Array<{ repositories: string[]; permissions: Record<string, string> }>;
  graphql: Array<{ query: string; variables: Record<string, unknown> }>;
  calls: number;
  /** When set, every GraphQL read waits here until released (forces two callers to read the same list). */
  gate: Promise<void> | null;
}
let fake: Fake;

function issue(repo: string, number: number, o: Partial<Issue> = {}): Issue {
  return {
    number, title: `${repo} issue ${number}`, url: `https://github.com/acme/${repo}/issues/${number}`,
    createdAt: `2026-10-${String(number).padStart(2, '0')}T10:00:00Z`, updatedAt: '2026-10-30T10:00:00Z',
    state: 'OPEN', labels: [], prs: [], ...o,
  };
}

async function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  fake.calls++;
  if (u.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
    const body = JSON.parse(String(init?.body));
    fake.mints.push(body);
    if (fake.mintStatus !== 201) return new Response('refused', { status: fake.mintStatus });
    return new Response(JSON.stringify({
      token: TOKEN, expires_at: '2026-11-02T07:00:00Z', permissions: body.permissions,
      repository_selection: 'selected', repositories: body.repositories.map((n: string) => ({ id: 1, full_name: `acme/${n}` })),
    }), { status: 201 });
  }
  if (u === 'https://api.github.com/graphql') {
    const body = JSON.parse(String(init?.body));
    fake.graphql.push(body);
    if (fake.gate) await fake.gate;
    const { name, after } = body.variables as { owner: string; name: string; after: string | null };
    if (fake.rateLimitOn === name) {
      return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    }
    const open = (fake.repos[name] ?? []).filter((i) => !/states:\s*OPEN/.test(body.query) || i.state === 'OPEN');
    const start = after ? Number(after) : 0;
    const slice = open.slice(start, start + fake.pageSize);
    const hasNextPage = start + fake.pageSize < open.length;
    return new Response(JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + fake.pageSize) : null },
            nodes: slice.map((i) => ({
              number: i.number, title: i.title, url: i.url, createdAt: i.createdAt, updatedAt: i.updatedAt,
              labels: { nodes: i.labels.map((l) => ({ name: l })), pageInfo: { hasNextPage: i.labelsTruncated === true } },
              closedByPullRequestsReferences: {
                nodes: i.prs.map((merged) => ({ merged })), pageInfo: { hasNextPage: i.prsTruncated === true },
              },
            })),
          },
        },
      },
    }), { status: 200 });
  }
  return new Response('unexpected url', { status: 599 });
}

// --- fixtures -------------------------------------------------------------------------------

let org: any, app: any, otherApp: any, bareApp: any, agentId: string;
let member: any, member2: any, outsider: any, anne: any, liam: any, zed: any;
let keyX: any, keyY: any, keyBare: any;
let logs: unknown[][];

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const keyCtx = (appId: string, appKeyId: string): Context => ({ db, appId, appKeyId, roles: [] });
const asWorker = <T,>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);

const INTEGRATION = () => ({
  name: 'gh', provider: 'github', repositories: ['acme/widgets', 'acme/gadgets'], readyLabel: 'ready',
  excludeLabels: ['wontfix'], teams: [{ lead: anne.id, label: 'team-anne' }],
});

const list = (args: Record<string, unknown> = {}, c: Context = ctx(member.id)) =>
  Q.untrackedTaskItems({}, { appRef: app.id, integration: 'gh', ...args }, c);
const claim = (args: Record<string, unknown> = {}, c: Context = ctx(member.id)) =>
  M.claimUntrackedTaskItems({}, { appRef: app.id, integration: 'gh', ...args }, c);
const urls = (r: { items: Array<{ url: string }> }) => r.items.map((i) => i.url);
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return { message: e?.message, code: e?.extensions?.code }; }
  throw new Error('expected a refusal');
};

beforeEach(async () => {
  await cleanDb(db);
  fake = { repos: {}, pageSize: 100, mintStatus: 201, rateLimitOn: null, mints: [], graphql: [], calls: 0, gate: null };
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubEnv('GITHUB_APP_ID', '3125300');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', APP_KEY_PEM);
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
  }

  const suffix = generateId().slice(-8);
  org = await db.organization.create({ data: { name: 'ut', urn: `ut-${suffix}.test`, githubInstallationId: INSTALLATION_ID } });
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: org.id } })).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  bareApp = await db.app.create({ data: { organizationId: org.id, name: 'Bare', urn: `${org.urn}:bare` } });
  [member, member2, outsider] = await Promise.all(['m1', 'm2', 'out'].map((h) => db.user.create({ data: { handle: `ut3125-${h}-${suffix}` } })));
  for (const u of [member, member2]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: outsider.id, role: 'member' } });
  await db.appMember.create({ data: { appId: bareApp.id, userId: outsider.id, role: 'member' } });
  const worker = (appId: string, name: string) => db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase(), heldByUserId: member.id, heldAt: new Date() },
    select: { id: true },
  });
  anne = await worker(app.id, 'Anne');
  liam = await worker(app.id, 'Liam');
  zed = await worker(otherApp.id, 'Zed');
  const key = (appId: string) => db.appKey.create({ data: { appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
  [keyX, keyY, keyBare] = await Promise.all([key(app.id), key(otherApp.id), key(bareApp.id)]);
  await db.app.update({ where: { id: app.id }, data: { properties: { taskIntegrations: [INTEGRATION()] } as never } });
  await db.app.update({
    where: { id: otherApp.id },
    data: { properties: { taskIntegrations: [{ name: 'gh-other', provider: 'github', repositories: ['acme/widgets'] }] } as never },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A task of `app` holding `externalId`, moved straight to `status` (the DB path; the API path is S2's). */
async function taskWith(externalId: string, status: string) {
  const now = new Date();
  return db.agentTask.create({
    data: {
      appId: app.id, title: 'held', externalId, ownerUserId: member.id, status,
      ...(status === 'backlog' ? {} : { assigneeUserId: member.id, assignedAt: now }),
      ...(status === 'started' || status === 'finished' ? { startedAt: now } : {}),
      ...(status === 'finished' ? { finishedAt: now, resultOutcome: 'done' } : {}),
      ...(status === 'cancelled' ? { cancelledAt: now } : {}),
    } as never,
  });
}

// --- listing --------------------------------------------------------------------------------

describe('untrackedTaskItems: what is listed (cor:agt:120:03)', () => {
  it('every open issue of every connected repository, oldest first, then repository, then number', async () => {
    fake.repos.widgets = [issue('widgets', 3), issue('widgets', 1, { createdAt: '2026-10-05T10:00:00Z' })];
    fake.repos.gadgets = [issue('gadgets', 5, { createdAt: '2026-10-05T10:00:00Z' }), issue('gadgets', 2)];
    const r = await list();
    expect(r.complete).toBe(true);
    expect(r.incompleteReason).toBeNull();
    expect(r.total).toBe(4);
    expect(r.items.map((i: any) => `${i.repository}#${i.number}`)).toEqual([
      'acme/gadgets#2', 'acme/widgets#3', 'acme/gadgets#5', 'acme/widgets#1',
    ]);
    expect(r.items[0]).toMatchObject({
      externalId: 'https://github.com/acme/gadgets/issues/2', url: 'https://github.com/acme/gadgets/issues/2',
      title: 'gadgets issue 2', labels: [], linkedPullRequestMerged: false,
    });
    expect(fake.graphql.every((g) => /states:\s*OPEN/.test(g.query))).toBe(true);
  });

  it('mints per repository, narrowed to that repository with issues, pull-request and metadata read', async () => {
    await list();
    expect(fake.mints).toEqual([
      { repositories: ['widgets'], permissions: { issues: 'read', pull_requests: 'read', metadata: 'read' } },
      { repositories: ['gadgets'], permissions: { issues: 'read', pull_requests: 'read', metadata: 'read' } },
    ]);
  });

  it('a closed issue is not listed', async () => {
    fake.repos.widgets = [issue('widgets', 1, { state: 'CLOSED' }), issue('widgets', 2)];
    expect(urls(await list({ repository: 'acme/widgets' }))).toEqual(['https://github.com/acme/widgets/issues/2']);
  });

  for (const status of ['backlog', 'pending', 'started', 'finished', 'cancelled']) {
    it(`an item a task of this App holds as externalId is not listed when that task is ${status}`, async () => {
      fake.repos.widgets = [issue('widgets', 1), issue('widgets', 2)];
      await taskWith('https://github.com/acme/widgets/issues/1', status);
      expect(urls(await list({ repository: 'acme/widgets' }))).toEqual(['https://github.com/acme/widgets/issues/2']);
    });
  }

  it("another App's task holding the same URL does not hide the item here", async () => {
    fake.repos.widgets = [issue('widgets', 1)];
    await db.agentTask.create({ data: { appId: otherApp.id, title: 'x', externalId: 'https://github.com/acme/widgets/issues/1', ownerUserId: outsider.id, status: 'backlog' } as never });
    expect(urls(await list({ repository: 'acme/widgets' }))).toEqual(['https://github.com/acme/widgets/issues/1']);
  });

  it('an item with an excluded label is not listed, whatever its case', async () => {
    fake.repos.widgets = [issue('widgets', 1, { labels: ['WontFix'] }), issue('widgets', 2, { labels: ['wontfix'] }), issue('widgets', 3, { labels: ['bug'] })];
    expect(urls(await list({ repository: 'acme/widgets' }))).toEqual(['https://github.com/acme/widgets/issues/3']);
  });

  it('ready ONLY keeps, EXCLUDE drops and ANY ignores the ready label, whatever its case', async () => {
    fake.repos.widgets = [issue('widgets', 1, { labels: ['Ready'] }), issue('widgets', 2, { labels: ['ready'] }), issue('widgets', 3)];
    const u = (n: number) => `https://github.com/acme/widgets/issues/${n}`;
    expect(urls(await list({ repository: 'acme/widgets', ready: 'ONLY' }))).toEqual([u(1), u(2)]);
    expect(urls(await list({ repository: 'acme/widgets', ready: 'EXCLUDE' }))).toEqual([u(3)]);
    expect(urls(await list({ repository: 'acme/widgets', ready: 'ANY' }))).toEqual([u(1), u(2), u(3)]);
    expect(urls(await list({ repository: 'acme/widgets' }))).toEqual([u(1), u(2), u(3)]);
  });

  it('team keeps only items carrying that team label; the lead may be named by id, name or URN', async () => {
    fake.repos.widgets = [issue('widgets', 1, { labels: ['TEAM-ANNE'] }), issue('widgets', 2, { labels: ['team-liam'] }), issue('widgets', 3)];
    for (const team of [anne.id, 'Anne']) {
      expect(urls(await list({ repository: 'acme/widgets', team }))).toEqual(['https://github.com/acme/widgets/issues/1']);
    }
  });

  it('linkedPullRequestMerged is true only when a closing pull request merged', async () => {
    fake.repos.widgets = [issue('widgets', 1, { prs: [false, true] }), issue('widgets', 2, { prs: [false] }), issue('widgets', 3)];
    const r = await list({ repository: 'acme/widgets' });
    expect(r.items.map((i: any) => i.linkedPullRequestMerged)).toEqual([true, false, false]);
  });

  it('pages are positional: two successive pages are disjoint and together the head of one unpaged read', async () => {
    fake.pageSize = 3; // forces the read itself to page too
    fake.repos.widgets = [1, 2, 3, 4, 5].map((n) => issue('widgets', n));
    fake.repos.gadgets = [1, 2, 3, 4].map((n) => issue('gadgets', n));
    const all = urls(await list({ limit: 100 }));
    expect(all).toHaveLength(9);
    const p1 = urls(await list({ skip: 0, limit: 3 }));
    const p2 = urls(await list({ skip: 3, limit: 3 }));
    expect(p1.filter((x) => p2.includes(x))).toEqual([]);
    expect([...p1, ...p2]).toEqual(all.slice(0, 6));
    expect((await list({ skip: 0, limit: 3 })).total).toBe(9);
  });

  it('a page defaults to 20; skip and limit out of range are BAD_USER_INPUT before any GitHub call', async () => {
    fake.repos.widgets = Array.from({ length: 25 }, (_, i) => issue('widgets', i + 1, { createdAt: `2026-09-01T10:00:${String(i).padStart(2, '0')}Z` }));
    expect((await list({ repository: 'acme/widgets' })).items).toHaveLength(20);
    const before = fake.calls;
    for (const args of [{ limit: 0 }, { limit: 101 }, { skip: -1 }]) {
      expect((await refusal(list(args))).code).toBe('BAD_USER_INPUT');
    }
    expect(fake.calls).toBe(before);
  });
});

describe('untrackedTaskItems: refusals, each before any GitHub call', () => {
  it('a repository not connected is refused, not answered empty', async () => {
    expect((await refusal(list({ repository: 'acme/other' }))).code).toBe('TASK_INTEGRATION_REPOSITORY_NOT_CONNECTED');
    expect(fake.calls).toBe(0);
  });

  it('a team that is unknown and a worker who leads no team answer the same', async () => {
    const a = await refusal(list({ team: 'Nobody' }));
    const b = await refusal(list({ team: liam.id }));
    const c = await refusal(list({ team: zed.id }));
    expect(a.code).toBe('TASK_INTEGRATION_TEAM_UNKNOWN');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fake.calls).toBe(0);
  });

  it("another App's integration name answers exactly as a name that exists nowhere", async () => {
    const theirs = await refusal(list({ integration: 'gh-other' }));
    const none = await refusal(list({ integration: 'nope' }));
    expect(theirs.code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect(theirs).toEqual(none);
    expect(fake.calls).toBe(0);
  });

  it('a non-participant gets APP_NOT_FOUND, the same whether the App has an integration or not', async () => {
    const withIntegration = await refusal(list({}, ctx(outsider.id)));
    await db.app.update({ where: { id: app.id }, data: { properties: Prisma.DbNull } });
    const without = await refusal(list({}, ctx(outsider.id)));
    expect(withIntegration.code).toBe('APP_NOT_FOUND');
    expect(without).toEqual(withIntegration);
    expect(fake.calls).toBe(0);
  });

  it('an App with no GitHub installation is GITHUB_NOT_INSTALLED', async () => {
    await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: null } });
    expect((await refusal(list())).code).toBe('GITHUB_NOT_INSTALLED');
  });

  it('an App with no organization is TASK_INTEGRATION_ORG_REQUIRED for list and claim, before any GitHub call (Ask 5)', async () => {
    // S1 refuses writing an integration on such an App; one stored by any other route is still never read.
    const mine = await db.app.create({
      data: { name: 'Mine', urn: `mine-${generateId()}:mine`, ownerUserId: member.id, properties: { taskIntegrations: [INTEGRATION()] } as never },
    });
    await db.appMember.create({ data: { appId: mine.id, userId: member.id, role: 'owner' } });
    for (const p of [list({ appRef: mine.id }), claim({ appRef: mine.id })]) {
      expect((await refusal(p)).code).toBe('TASK_INTEGRATION_ORG_REQUIRED');
    }
    // The same answer whether or not the integration name exists.
    expect((await refusal(list({ appRef: mine.id, integration: 'nope' }))).code).toBe('TASK_INTEGRATION_ORG_REQUIRED');
    expect(fake.calls).toBe(0);
    expect(await db.agentTask.count({ where: { appId: mine.id } })).toBe(0);
  });

  it('an installation that cannot grant the read refuses the whole call GITHUB_PERMISSION_MISSING', async () => {
    fake.mintStatus = 422;
    const r = await refusal(list());
    expect(r.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(r.message).not.toContain(TOKEN);
  });
});

describe('untrackedTaskItems: App keys (V38)', () => {
  it("the App's own key lists its items", async () => {
    fake.repos.widgets = [issue('widgets', 1)];
    const r = await list({ repository: 'acme/widgets' }, keyCtx(app.id, keyX.id));
    expect(urls(r)).toEqual(['https://github.com/acme/widgets/issues/1']);
  });

  it("another App's key gets APP_NOT_FOUND, the same whether the target App has an integration or not", async () => {
    const a = await refusal(list({}, keyCtx(otherApp.id, keyY.id)));
    const b = await refusal(Q.untrackedTaskItems({}, { appRef: bareApp.id, integration: 'gh' }, keyCtx(otherApp.id, keyY.id)));
    expect(a.code).toBe('APP_NOT_FOUND');
    expect({ ...b, message: b.message.replace(bareApp.id, app.id) }).toEqual(a);
    expect(fake.calls).toBe(0);
  });
});

describe('untrackedTaskItems: an incomplete read', () => {
  it('a rate limit mid-read returns complete: false, and the token appears nowhere', async () => {
    fake.repos.widgets = [issue('widgets', 1)];
    fake.repos.gadgets = [issue('gadgets', 2)];
    fake.rateLimitOn = 'gadgets';
    const r = await list();
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe('rate_limited');
    expect(urls(r)).toEqual(['https://github.com/acme/widgets/issues/1']);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('an issue whose labels run past one page is left out and the list is item_truncated', async () => {
    // Its labels decide exclude/team/ready: the unread page could carry `wontfix`, so it is not listed on a guess.
    fake.repos.widgets = [issue('widgets', 1, { labels: ['ready'], labelsTruncated: true }), issue('widgets', 2)];
    fake.repos.gadgets = [];
    const r = await list();
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe('item_truncated');
    expect(urls(r)).toEqual(['https://github.com/acme/widgets/issues/2']);
  });

  it('an issue whose closing pull requests run past one page is left out and the list is item_truncated', async () => {
    // The merged flag could sit on the unread page; listing it as not merged would be a guess.
    fake.repos.widgets = [issue('widgets', 1, { prs: [false], prsTruncated: true }), issue('widgets', 2)];
    fake.repos.gadgets = [];
    const r = await list();
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe('item_truncated');
    expect(urls(r)).toEqual(['https://github.com/acme/widgets/issues/2']);
  });

  it('a claim never takes a truncated item, and reports the list incomplete', async () => {
    fake.repos.widgets = [issue('widgets', 1, { labelsTruncated: true }), issue('widgets', 2)];
    const r: any = await asWorker(anne, () => claim({ repository: 'acme/widgets', limit: 5 }));
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe('item_truncated');
    expect(r.tasks.map((t: any) => t.externalId)).toEqual(['https://github.com/acme/widgets/issues/2']);
  });

  it('a repository is read for at most 20 pages, then the list is page_limit with what was read', async () => {
    fake.pageSize = 1;
    fake.repos.widgets = Array.from({ length: 21 }, (_, k) => issue('widgets', k + 1));
    fake.repos.gadgets = [issue('gadgets', 30)];
    const r = await list({ limit: 100 });
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe('page_limit');
    expect(fake.graphql.filter((g) => g.variables.name === 'widgets')).toHaveLength(20);
    expect(urls(r)).toEqual([
      ...Array.from({ length: 20 }, (_, k) => `https://github.com/acme/widgets/issues/${k + 1}`),
      'https://github.com/acme/gadgets/issues/30',
    ]);
  });

  it('exactly 20 pages that end the repository are complete', async () => {
    fake.pageSize = 1;
    fake.repos.widgets = Array.from({ length: 20 }, (_, k) => issue('widgets', k + 1));
    fake.repos.gadgets = [];
    const r = await list({ limit: 100 });
    expect(r.complete).toBe(true);
    expect(r.incompleteReason).toBeNull();
    expect(r.total).toBe(20);
  });
});

// --- claiming -------------------------------------------------------------------------------

describe('claimUntrackedTaskItems (cor:agt:120:03)', () => {
  it('with no limit claims one item: started, owned by and assigned to the caller, no parent', async () => {
    fake.repos.widgets = [issue('widgets', 1), issue('widgets', 2)];
    const r: any = await asWorker(anne, () => claim({ repository: 'acme/widgets' }));
    expect(r.complete).toBe(true);
    expect(r.incompleteReason).toBeNull();
    expect(r.refusalCode).toBeNull();
    expect(r.tasks).toHaveLength(1);
    const t = await db.agentTask.findUniqueOrThrow({ where: { id: r.tasks[0].id } });
    expect(t).toMatchObject({
      status: 'started', ownerWorkerId: anne.id, assigneeWorkerId: anne.id,
      externalId: 'https://github.com/acme/widgets/issues/1', source: 'https://github.com/acme/widgets/issues/1',
      title: 'widgets issue 1',
    });
    expect(t.startedAt).toBeInstanceOf(Date);
    // A root task, as createAgentTask makes one with no parent: filed under the App's reserved project AT0.
    const parent = await db.agentTask.findUniqueOrThrow({ where: { id: t.parentTaskId! } });
    expect(parent.handle).toBe('AT0');
    expect(t.handle).toMatch(/^AT0\.\d+$/);
    expect(t.references).toEqual([{ kind: 'issue', target: 'https://github.com/acme/widgets/issues/1', label: null }]);
  });

  it('records task.created then task.started, and the stall evaluator raises no not-started alarm for it', async () => {
    fake.repos.widgets = [issue('widgets', 1)];
    const r: any = await asWorker(anne, () => claim({ repository: 'acme/widgets' }));
    const taskId = r.tasks[0].id;
    const events = await db.agentTeamEvent.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const types = events.map((e) => e.type);
    expect(types.indexOf('task.created')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('task.started')).toBeGreaterThan(types.indexOf('task.created'));
    await taskStallTick(db as never, new Date(Date.now() + 30 * 60_000));
    const alarms = await db.agentTeamEvent.findMany({ where: { taskId, severity: 'alarm' } });
    expect(alarms.filter((a) => JSON.stringify(a.payload).includes('not-started'))).toEqual([]);
  });

  it('a pending task assigned the same way WOULD alarm (the pin above is not vacuous)', async () => {
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'p', ownerWorkerId: anne.id, assigneeWorkerId: anne.id, status: 'pending', assignedAt: new Date() } as never,
    });
    await taskStallTick(db as never, new Date(Date.now() + 30 * 60_000));
    const alarms = await db.agentTeamEvent.findMany({ where: { taskId: t.id, severity: 'alarm' } });
    expect(alarms.length).toBeGreaterThan(0);
  });

  it('claims up to limit in order, skipping items already held; limit out of range is BAD_USER_INPUT', async () => {
    fake.repos.widgets = [1, 2, 3, 4].map((n) => issue('widgets', n));
    await taskWith('https://github.com/acme/widgets/issues/2', 'finished');
    const r = await claim({ repository: 'acme/widgets', limit: 2 });
    expect(r.tasks.map((t: any) => t.externalId)).toEqual(['https://github.com/acme/widgets/issues/1', 'https://github.com/acme/widgets/issues/3']);
    for (const limit of [0, 11]) expect((await refusal(claim({ limit }))).code).toBe('BAD_USER_INPUT');
  });

  it("an App key's claim is refused TASK_CLAIM_PRINCIPAL_UNSUPPORTED before any GitHub call; another App's key is APP_NOT_FOUND", async () => {
    fake.repos.widgets = [issue('widgets', 1)];
    expect((await refusal(claim({}, keyCtx(app.id, keyX.id)))).code).toBe('TASK_CLAIM_PRINCIPAL_UNSUPPORTED');
    expect((await refusal(claim({}, keyCtx(otherApp.id, keyY.id)))).code).toBe('APP_NOT_FOUND');
    expect(fake.calls).toBe(0);
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: { not: null } } })).toBe(0);
  });

  it('a non-participant claim is APP_NOT_FOUND, the same whether the App has an integration or not', async () => {
    const a = await refusal(claim({}, ctx(outsider.id)));
    const b = await refusal(M.claimUntrackedTaskItems({}, { appRef: bareApp.id, integration: 'gh' }, ctx(member.id)));
    expect(a.code).toBe('APP_NOT_FOUND');
    expect({ ...b, message: b.message.replace(bareApp.id, app.id) }).toEqual(a);
    expect(fake.calls).toBe(0);
  });

  it('a refusal mid-walk stops it and is returned beside the claims already made, which stay committed', async () => {
    const long = `https://github.com/acme/widgets/issues/2?${'x'.repeat(520)}`;
    fake.repos.widgets = [issue('widgets', 1), issue('widgets', 2, { url: long }), issue('widgets', 3)];
    const r = await claim({ repository: 'acme/widgets', limit: 3 });
    expect(r.tasks.map((t: any) => t.externalId)).toEqual(['https://github.com/acme/widgets/issues/1']);
    expect(r).toMatchObject({ complete: false, incompleteReason: 'claim_refused', refusalCode: 'BAD_USER_INPUT' });
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: { not: null } } })).toBe(1);
  });

  it('two concurrent callers over one list of 2N items each get N, disjoint (the taken-id skip path runs)', async () => {
    fake.repos.widgets = [1, 2, 3, 4].map((n) => issue('widgets', n));
    let release!: () => void;
    fake.gate = new Promise<void>((r) => { release = r; });
    const a = claim({ repository: 'acme/widgets', limit: 2 }, ctx(member.id));
    const b = claim({ repository: 'acme/widgets', limit: 2 }, ctx(member2.id));
    while (fake.graphql.length < 2) await new Promise((r) => setTimeout(r, 5));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    const ia = ra.tasks.map((t: any) => t.externalId);
    const ib = rb.tasks.map((t: any) => t.externalId);
    expect(ia).toHaveLength(2);
    expect(ib).toHaveLength(2);
    expect(ia.filter((x: string) => ib.includes(x))).toEqual([]);
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: { not: null } } })).toBe(4);
  });

  it('with 2N-1 items the two callers together get 2N-1 distinct tasks', async () => {
    fake.repos.widgets = [1, 2, 3].map((n) => issue('widgets', n));
    let release!: () => void;
    fake.gate = new Promise<void>((r) => { release = r; });
    const a = claim({ repository: 'acme/widgets', limit: 2 }, ctx(member.id));
    const b = claim({ repository: 'acme/widgets', limit: 2 }, ctx(member2.id));
    while (fake.graphql.length < 2) await new Promise((r) => setTimeout(r, 5));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    const all = [...ra.tasks, ...rb.tasks].map((t: any) => t.externalId);
    expect(new Set(all).size).toBe(3);
    expect(all).toHaveLength(3);
  });

  it('a claimed title is the tracker text with control and format characters spaced out, clipped to the title cap', async () => {
    fake.repos.widgets = [issue('widgets', 1, { title: `Fix\u0007the\u200Bthing ${'y'.repeat(600)}` })];
    const r = await claim({ repository: 'acme/widgets' });
    const title: string = r.tasks[0].title;
    expect(title.startsWith('Fix the thing ')).toBe(true);
    expect(/[\u0000-\u001F\u200B]/.test(title)).toBe(false);
    expect(Array.from(title).length).toBeLessThanOrEqual(500);
  });
});

// --- through the SDL -------------------------------------------------------------------------

describe('through the SDL', () => {
  it('the query and the mutation execute', async () => {
    fake.repos.widgets = [issue('widgets', 1, { labels: ['ready'], prs: [true] })];
    const api = new ApolloServer<Context>({ typeDefs, resolvers });
    await api.start();
    try {
      const run = async (query: string) => {
        const r = await api.executeOperation({ query, variables: { a: app.id } }, { contextValue: ctx(member.id) });
        if (r.body.kind !== 'single') throw new Error('unexpected body');
        return r.body.singleResult as { data?: any; errors?: any[] };
      };
      const l = await run('query($a:ID!){untrackedTaskItems(appRef:$a,integration:"gh",repository:"acme/widgets",ready:ONLY){total complete incompleteReason items{externalId repository number title url labels createdAt updatedAt linkedPullRequestMerged}}}');
      expect(l.errors).toBeUndefined();
      expect(l.data.untrackedTaskItems).toMatchObject({ total: 1, complete: true, items: [{ number: 1, labels: ['ready'], linkedPullRequestMerged: true }] });
      const c = await run('mutation($a:ID!){claimUntrackedTaskItems(appRef:$a,integration:"gh",repository:"acme/widgets"){complete incompleteReason refusalCode tasks{id status externalId}}}');
      expect(c.errors).toBeUndefined();
      expect(c.data.claimUntrackedTaskItems).toMatchObject({ complete: true, refusalCode: null, tasks: [{ status: 'STARTED', externalId: 'https://github.com/acme/widgets/issues/1' }] });
    } finally { await api.stop(); }
  });
});
