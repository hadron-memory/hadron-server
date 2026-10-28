/**
 * github_issue_snapshot (#2485, epic #2435 slice C): a headless run reads GitHub issues through a
 * per-call, down-scoped, read-only installation token minted from the SAME GitHub App and
 * installation the memory sync uses (Holger's ruling on the issue, 6432580535: narrowing the
 * existing integration is not a new credential).
 *
 * GitHub is faked at `fetch`. The token is synthetic and must never surface: not in the result,
 * the hop trail, the logs, or a refusal's message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolveRunTools } from './index.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext, RunToolDef } from './types.js';

const ORG_URN = 'gh-snap-org';
const FLOW_MEM_URN = `${ORG_URN}:flows`;
const NODE_URN = `${ORG_URN}::flows::flow:report`;
const INSTALLATION_ID = 424242;
const TOKEN = 'ghs_SYNTHETIC2485tokenNEVERreal00000000000';
const GITHUB_ERROR_BODY = 'SECRET-ish GitHub error body that must not be echoed';

const { privateKey: APP_KEY_PEM } = (() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string };
})();

let orgId: string;
let appId: string;
let flowMemoryId: string;

// --- fake GitHub ----------------------------------------------------------------------------

interface Fake {
  mintBodies: unknown[];
  mintStatus: number;
  mintPermissions: Record<string, string>;
  mintRepositories: Array<Record<string, unknown>> | undefined;
  graphqlBodies: Array<{ query: string; variables: Record<string, unknown> }>;
  graphqlAuth: string[];
  pages: Array<() => Response>;
  calls: string[];
}
let fake: Fake;

function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  fake.calls.push(u);
  if (u.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
    fake.mintBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    if (fake.mintStatus !== 201) {
      return Promise.resolve(new Response(GITHUB_ERROR_BODY, { status: fake.mintStatus }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: TOKEN,
          expires_at: '2026-10-27T07:00:00Z',
          permissions: fake.mintPermissions,
          repository_selection: 'selected',
          ...(fake.mintRepositories ? { repositories: fake.mintRepositories } : {}),
        }),
        { status: 201 },
      ),
    );
  }
  if (u === 'https://api.github.com/graphql') {
    fake.graphqlAuth.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
    fake.graphqlBodies.push(JSON.parse(String(init?.body)));
    const next = fake.pages.shift();
    if (!next) return Promise.resolve(new Response('no page queued', { status: 500 }));
    return Promise.resolve(next());
  }
  return Promise.resolve(new Response('unexpected url', { status: 599 }));
}

type IssueFixture = Record<string, unknown>;
const issue = (n: number, o: IssueFixture = {}): IssueFixture => ({
  id: `I_${n}`,
  number: n,
  title: `Issue ${n}`,
  state: 'OPEN',
  stateReason: null,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-21T10:00:00Z',
  closedAt: null,
  url: `https://github.com/acme/widgets/issues/${n}`,
  labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false } },
  parent: null,
  subIssues: { nodes: [], pageInfo: { hasNextPage: false } },
  timelineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...o,
});
const page = (issues: IssueFixture[], pageInfo = { hasNextPage: false, endCursor: 'CUR1' }) => () =>
  new Response(
    JSON.stringify({
      data: {
        repository: {
          id: 'R_kgDOwidgets',
          nameWithOwner: 'acme/widgets',
          url: 'https://github.com/acme/widgets',
          issues: { pageInfo, nodes: issues },
        },
      },
    }),
    { status: 200 },
  );

/** A follow-up page for one issue's nested lists, answered to the node(id:) query. */
const nested = (node: IssueFixture | null) => () =>
  new Response(JSON.stringify({ data: { node } }), { status: 200 });
const raw = (body: string) => () => new Response(body, { status: 200 });

// --- fixtures -------------------------------------------------------------------------------

async function mintRun(): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: orgId, appId, triggerKind: 'MANUAL',
      entryNodeUrn: NODE_URN, status: 'RUNNING',
    },
  });
}

function toolCtx(run: AppRun, nodeUrn: string | undefined = NODE_URN): RunToolContext & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn(), db, run, principal: runContext(db, run), nodeUrn } as never;
}

async function setFlowNodeData(data: Record<string, unknown>) {
  await db.node.upsert({
    where: { loc_memoryId: { loc: 'flow:report', memoryId: flowMemoryId } },
    create: { id: generateId(), memoryId: flowMemoryId, loc: 'flow:report', name: 'report', data: data as never },
    update: { data: data as never },
  });
}

async function connectorMemory(source: string) {
  await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: `m-${generateId()}`,
      urn: `${ORG_URN}:m-${generateId()}`, class: 'knowledge', visibility: 'ORGANIZATION', source,
    },
  });
}

/** The tool from the registry; on main it is absent and each pin fails on this line. */
function snapshotTool(): RunToolDef {
  const { tools, unknown } = resolveRunTools(['github_issue_snapshot']);
  expect(unknown, 'github_issue_snapshot is not a registered run tool').toEqual([]);
  return tools.find((t) => t.name === 'github_issue_snapshot')!;
}

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return { code: (e as { code?: string }).code, message: String((e as Error).message) };
  }
  throw new Error('expected a refusal, got a result');
}

const WINDOW = { since: '2026-10-15T00:00:00Z', until: '2026-10-22T00:00:00Z' };
const ARGS = { repository: 'acme/widgets', ...WINDOW };

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(async () => {
  await cleanDb(db);
  fake = {
    mintBodies: [], mintStatus: 201, mintPermissions: { issues: 'read', metadata: 'read' },
    mintRepositories: [{ id: 1, full_name: 'acme/widgets' }],
    graphqlBodies: [], graphqlAuth: [], pages: [], calls: [],
  };
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubEnv('GITHUB_APP_ID', '3125298');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', APP_KEY_PEM);
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );

  const org = await db.organization.create({
    data: { id: generateId(), name: ORG_URN, urn: ORG_URN, githubInstallationId: INSTALLATION_ID },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'gh-app', urn: `${ORG_URN}::gh-app` },
  });
  appId = app.id;
  const flowMem = await db.memory.create({
    data: { id: generateId(), organizationId: orgId, name: 'flows', urn: FLOW_MEM_URN, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  flowMemoryId = flowMem.id;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: 'gh-agent', urn: `${ORG_URN}:gh-agent` },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: flowMemoryId, role: 'read' } });

  await connectorMemory('https://github.com/acme/widgets.git');
  await setFlowNodeData({ tools: ['github_issue_snapshot'], github: { repositories: ['acme/widgets'] } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const s of consoleSpies) s.mockRestore();
});

function expectNoToken(...haystacks: unknown[]) {
  for (const h of haystacks) expect(JSON.stringify(h ?? null)).not.toContain(TOKEN);
  for (const s of consoleSpies) expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN);
}

describe('github_issue_snapshot: registration (#2485)', () => {
  it('is a registered run tool at cost 0 under policy action tool.github_issue_snapshot', () => {
    const def = snapshotTool();
    expect(def.cost).toBe(0);
    expect(def.policyAction ?? `tool.${def.name}`).toBe('tool.github_issue_snapshot');
    // No argument can carry a credential, a URL or a command.
    const props = Object.keys((def.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props.sort()).toEqual(['cursor', 'repository', 'since', 'until']);
  });
});

describe('github_issue_snapshot: the down-scoped mint (#2485 acceptance 1)', () => {
  it('mints with exactly the one repository and issues:read + metadata:read, per call, and reads with that token', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1)]));
    fake.pages.push(page([issue(1)]));
    const run = await mintRun();
    await def.execute(toolCtx(run), ARGS);
    await def.execute(toolCtx(run), ARGS);
    expect(fake.mintBodies).toEqual([
      { repositories: ['widgets'], permissions: { issues: 'read', metadata: 'read' } },
      { repositories: ['widgets'], permissions: { issues: 'read', metadata: 'read' } },
    ]);
    expect(fake.graphqlAuth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it('refuses a minted token whose granted permissions are wider than the request, before reading', async () => {
    const def = snapshotTool();
    fake.mintPermissions = { issues: 'read', metadata: 'read', contents: 'write' };
    fake.pages.push(page([issue(1)]));
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), ARGS));
    expect(r.code).toBe('GITHUB_TOKEN_SCOPE_MISMATCH');
    expect(fake.graphqlBodies).toHaveLength(0);
    expect(r.message).not.toContain(TOKEN);
  });

  it.each([
    ['another owner\'s repository of the same name', [{ id: 1, full_name: 'other/widgets' }]],
    ['two repositories', [{ id: 1, full_name: 'acme/widgets' }, { id: 2, full_name: 'acme/gadgets' }]],
    ['no repository list', undefined],
  ])('refuses a minted token scoped to %s, before reading (Ralion P3-3)', async (_label, repos) => {
    const def = snapshotTool();
    fake.mintRepositories = repos as never;
    fake.pages.push(page([issue(1)]));
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), ARGS));
    expect(r.code).toBe('GITHUB_TOKEN_SCOPE_MISMATCH');
    expect(fake.graphqlBodies).toHaveLength(0);
  });

  it('accepts the granted repository case-insensitively', async () => {
    const def = snapshotTool();
    fake.mintRepositories = [{ id: 1, full_name: 'Acme/Widgets' }];
    fake.pages.push(page([issue(1)]));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out.complete).toBe(true);
  });

  it('the sync path still mints without a scoping body (push unchanged)', async () => {
    const { getInstallationToken } = await import('../../../integrations/github/githubApp.js');
    await getInstallationToken(INSTALLATION_ID);
    expect(fake.mintBodies).toEqual([undefined]);
  });
});

describe('github_issue_snapshot: the snapshot (#2485 acceptance 2)', () => {
  it('returns repository identity, acquisition time, issues with links and labels, window events, cursor and complete', async () => {
    const def = snapshotTool();
    fake.pages.push(
      page([
        issue(10, {
          title: 'Parent',
          createdAt: '2026-10-16T09:00:00Z',
          subIssues: {
            nodes: [{ number: 11, repository: { nameWithOwner: 'acme/widgets' } }],
            pageInfo: { hasNextPage: false },
          },
        }),
        issue(11, {
          state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-10-20T12:00:00Z',
          labels: { nodes: [{ name: 'p2' }, { name: 'server' }], pageInfo: { hasNextPage: false } },
          parent: { number: 10, repository: { nameWithOwner: 'acme/widgets' } },
          timelineItems: {
            nodes: [
              { __typename: 'ClosedEvent', createdAt: '2026-10-18T08:00:00Z' },
              { __typename: 'ReopenedEvent', createdAt: '2026-10-19T08:00:00Z' },
              { __typename: 'ClosedEvent', createdAt: '2026-10-20T12:00:00Z' },
              { __typename: 'ClosedEvent', createdAt: '2026-10-23T12:00:00Z' }, // after the window
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
      ]),
    );
    const run = await mintRun();
    const before = Date.now();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;

    expect(out.repository).toEqual({ nameWithOwner: 'acme/widgets', id: 'R_kgDOwidgets', url: 'https://github.com/acme/widgets' });
    expect(out.window).toEqual(WINDOW);
    expect(Date.parse(out.acquiredAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(out.complete).toBe(true);
    expect(out.cursor).toBeNull();
    expect(out.source).toBe('external');
    expect(out.issues.map((i: any) => i.number)).toEqual([10, 11]);
    expect(out.issues[1]).toMatchObject({
      state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-10-20T12:00:00Z',
      labels: ['p2', 'server'], parent: { repository: 'acme/widgets', number: 10 },
    });
    expect(out.issues[0].subIssues).toEqual([{ repository: 'acme/widgets', number: 11 }]);
    expect(out.events).toEqual([
      { issue: 10, type: 'opened', at: '2026-10-16T09:00:00Z' },
      { issue: 11, type: 'closed', at: '2026-10-18T08:00:00Z' },
      { issue: 11, type: 'reopened', at: '2026-10-19T08:00:00Z' },
      { issue: 11, type: 'closed', at: '2026-10-20T12:00:00Z' },
    ]);
    // The query asks GitHub for issues updated since the window start, and nothing else.
    expect(fake.graphqlBodies[0]!.variables).toMatchObject({ owner: 'acme', name: 'widgets', since: WINDOW.since });
  });

  it('a cursor argument resumes the issue listing after that cursor', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(3)]));
    const run = await mintRun();
    await def.execute(toolCtx(run), { ...ARGS, cursor: 'Y3Vyc29yOnYyOpK5MjAyNi0xMC0yMQ==' });
    expect(fake.graphqlBodies[0]!.variables.after).toBe('Y3Vyc29yOnYyOpK5MjAyNi0xMC0yMQ==');
  });
});

describe('github_issue_snapshot: repository reach is the intersection (#2485 acceptance 3)', () => {
  it('refuses a node-allowlisted repository that no memory of the org syncs, before minting', async () => {
    const def = snapshotTool();
    await setFlowNodeData({ tools: ['github_issue_snapshot'], github: { repositories: ['acme/widgets', 'acme/secrets'] } });
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), { ...ARGS, repository: 'acme/secrets' }));
    expect(r.code).toBe('GITHUB_REPOSITORY_NOT_ALLOWED');
    expect(fake.calls).toEqual([]);
  });

  it('refuses a connector repository the flow node does not allowlist, before minting', async () => {
    const def = snapshotTool();
    await connectorMemory('https://github.com/acme/gadgets');
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), { ...ARGS, repository: 'acme/gadgets' }));
    expect(r.code).toBe('GITHUB_REPOSITORY_NOT_ALLOWED');
    expect(fake.calls).toEqual([]);
  });

  it('does not count a soft-deleted memory\'s source toward reach (Ralion P3-2)', async () => {
    const def = snapshotTool();
    await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'gone', urn: `${ORG_URN}:gone`, class: 'knowledge',
        visibility: 'ORGANIZATION', source: 'https://github.com/acme/gadgets', deletedAt: new Date(),
      },
    });
    await setFlowNodeData({ tools: ['github_issue_snapshot'], github: { repositories: ['acme/widgets', 'acme/gadgets'] } });
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), { ...ARGS, repository: 'acme/gadgets' }));
    expect(r.code).toBe('GITHUB_REPOSITORY_NOT_ALLOWED');
    expect(fake.calls).toEqual([]);
  });

  it('refuses everything when the flow node declares no github.repositories', async () => {
    const def = snapshotTool();
    await setFlowNodeData({ tools: ['github_issue_snapshot'] });
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), ARGS));
    expect(r.code).toBe('GITHUB_REPOSITORY_NOT_ALLOWED');
    expect(fake.calls).toEqual([]);
  });

  it('fails closed when the tool context does not name the executing flow node', async () => {
    const def = snapshotTool();
    const run = await mintRun();
    await expect(def.execute({ ...toolCtx(run), nodeUrn: undefined }, ARGS)).rejects.toThrow(/executing flow node is unknown/);
    expect(fake.calls).toEqual([]);
  });

  it('does not count another org\'s memory sources toward this run\'s reach', async () => {
    const def = snapshotTool();
    const other = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'gh-snap-other' } });
    await db.memory.create({
      data: { id: generateId(), organizationId: other.id, name: 'o', urn: 'gh-snap-other:o', class: 'knowledge', visibility: 'ORGANIZATION', source: 'https://github.com/acme/gadgets' },
    });
    await setFlowNodeData({ tools: ['github_issue_snapshot'], github: { repositories: ['acme/gadgets'] } });
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), { ...ARGS, repository: 'acme/gadgets' }));
    expect(r.code).toBe('GITHUB_REPOSITORY_NOT_ALLOWED');
    expect(fake.calls).toEqual([]);
  });
});

describe('github_issue_snapshot: arguments carry no credential, URL or command (#2485 ask 3)', () => {
  it.each([
    ['a token argument', { ...ARGS, token: 'ghp_attacker' }],
    ['a url argument', { ...ARGS, url: 'https://evil.example/graphql' }],
    ['a URL as the repository', { ...ARGS, repository: 'https://github.com/acme/widgets' }],
    ['a path-traversing repository', { ...ARGS, repository: 'acme/../widgets' }],
    ['no since', { repository: 'acme/widgets' }],
    ['a since after until', { ...ARGS, since: '2026-10-23T00:00:00Z' }],
    ['a window wider than 93 days', { ...ARGS, since: '2026-06-01T00:00:00Z' }],
    ['a non-ISO since', { ...ARGS, since: 'last week' }],
    ['a nonexistent calendar date (Glen P3)', { ...ARGS, since: '2026-02-30T00:00:00Z', until: '2026-03-05T00:00:00Z' }],
    ['hour 24', { ...ARGS, since: '2026-10-15T24:00:00Z' }],
    ['minute 60', { ...ARGS, until: '2026-10-21T10:60:00Z' }],
  ])('refuses %s before any GitHub call', async (_label, args) => {
    const def = snapshotTool();
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), args as Record<string, unknown>));
    expect(r.code).toBe('GITHUB_INVALID_ARGUMENT');
    expect(fake.calls).toEqual([]);
  });
});

describe('github_issue_snapshot: missing installation or permission (#2485 acceptance 4)', () => {
  it('an org with no GitHub installation gives GITHUB_NOT_INSTALLED, with no GitHub call', async () => {
    const def = snapshotTool();
    await db.organization.update({ where: { id: orgId }, data: { githubInstallationId: null } });
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), ARGS));
    expect(r.code).toBe('GITHUB_NOT_INSTALLED');
    expect(fake.calls).toEqual([]);
  });

  it.each([403, 404, 422])('a refused mint (%i) gives GITHUB_PERMISSION_MISSING without echoing GitHub\'s body', async (status) => {
    const def = snapshotTool();
    fake.mintStatus = status;
    const run = await mintRun();
    const r = await refusal(def.execute(toolCtx(run), ARGS));
    expect(r.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(r.message).not.toContain(GITHUB_ERROR_BODY);
    expect(fake.graphqlBodies).toHaveLength(0);
  });
});

describe('github_issue_snapshot: never a partial result presented as whole (#2485 acceptance 5)', () => {
  it('a rate limit on page 2 keeps page 1, says complete:false and hands back the resume cursor', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1)], { hasNextPage: true, endCursor: 'AFTER1' }));
    fake.pages.push(() => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toBe('rate_limited');
    expect(out.cursor).toBe('AFTER1');
    expect(out.issues.map((i: any) => i.number)).toEqual([1]);
  });

  it('a GraphQL RATE_LIMITED error is a rate limit too', async () => {
    const def = snapshotTool();
    fake.pages.push(() => new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'x' }] }), { status: 200 }));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'rate_limited', cursor: null, issues: [] });
  });

  it('a mid-listing GitHub failure says complete:false (github_error), never complete', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1)], { hasNextPage: true, endCursor: 'AFTER1' }));
    fake.pages.push(() => new Response('boom', { status: 502 }));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'github_error', cursor: 'AFTER1' });
  });

  it('follows a truncated nested list to its end, so every label, sub-issue and event arrives (Glen P2)', async () => {
    const def = snapshotTool();
    fake.pages.push(
      page([
        issue(1, {
          labels: { nodes: [{ name: 'a' }], pageInfo: { hasNextPage: true, endCursor: 'L1' } },
          subIssues: {
            nodes: [{ number: 2, repository: { nameWithOwner: 'acme/widgets' } }],
            pageInfo: { hasNextPage: true, endCursor: 'S1' },
          },
          timelineItems: {
            nodes: [{ __typename: 'ClosedEvent', createdAt: '2026-10-16T00:00:00Z' }],
            pageInfo: { hasNextPage: true, endCursor: 'T1' },
          },
        }),
        issue(9),
      ]),
    );
    // First follow-up: all three lists continue; labels finish.
    fake.pages.push(
      nested({
        labels: { nodes: [{ name: 'b' }], pageInfo: { hasNextPage: false, endCursor: 'L2' } },
        subIssues: {
          nodes: [{ number: 3, repository: { nameWithOwner: 'acme/widgets' } }],
          pageInfo: { hasNextPage: true, endCursor: 'S2' },
        },
        timelineItems: {
          nodes: [{ __typename: 'ReopenedEvent', createdAt: '2026-10-17T00:00:00Z' }],
          pageInfo: { hasNextPage: false, endCursor: 'T2' },
        },
      }),
    );
    // Second follow-up: only sub-issues are still open.
    fake.pages.push(
      nested({
        subIssues: {
          nodes: [{ number: 4, repository: { nameWithOwner: 'acme/widgets' } }],
          pageInfo: { hasNextPage: false, endCursor: 'S3' },
        },
      }),
    );
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;

    expect(out).toMatchObject({ complete: true, cursor: null });
    expect(out.incompleteReason).toBeUndefined();
    expect(out.issues[0].truncated).toBeUndefined();
    expect(out.issues[0].labels).toEqual(['a', 'b']);
    expect(out.issues[0].subIssues.map((x: any) => x.number)).toEqual([2, 3, 4]);
    expect(out.events.filter((e: any) => e.issue === 1)).toEqual([
      { issue: 1, type: 'opened', at: '2026-10-01T10:00:00Z' },
      { issue: 1, type: 'closed', at: '2026-10-16T00:00:00Z' },
      { issue: 1, type: 'reopened', at: '2026-10-17T00:00:00Z' },
    ].filter((e) => e.at >= WINDOW.since));
    expect(out.issues.map((i: any) => i.number)).toEqual([1, 9]);

    // Each follow-up names the issue, resumes each list after its own cursor, and skips finished lists.
    const [, f1, f2] = fake.graphqlBodies;
    expect(f1!.variables).toMatchObject({
      id: 'I_1', since: WINDOW.since,
      labels: true, labelsAfter: 'L1', subs: true, subsAfter: 'S1', timeline: true, timelineAfter: 'T1',
    });
    expect(f2!.variables).toMatchObject({ id: 'I_1', labels: false, subs: true, subsAfter: 'S2', timeline: false });
    expect(fake.graphqlBodies).toHaveLength(3);
  });

  it('a nested list longer than one call can follow is marked truncated and reported as terminal, not resumable', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1, { subIssues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'S0' } } })]));
    for (let i = 0; i < 50; i++) {
      fake.pages.push(nested({ subIssues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `S${i + 1}` } } }));
    }
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'nested_truncated', cursor: null });
    expect(out.issues[0].truncated).toBe(true);
    expect(fake.graphqlBodies.length).toBeLessThan(50);
    // The model is told this reason is final, so it does not restart the listing for it.
    expect(def.description).toMatch(/nested_truncated[^.]*will not/);
  });

  it('the follow-up budget is shared across a first page: issues past it are cut, the ones before it are whole (Glen P3)', async () => {
    const def = snapshotTool();
    const { GITHUB_SNAPSHOT_MAX_NESTED_PAGES } = await import('../../githubIssueSnapshot.js');
    const n = GITHUB_SNAPSHOT_MAX_NESTED_PAGES + 1;
    const open = (i: number) =>
      issue(i, { labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `L${i}` } } });
    fake.pages.push(page(Array.from({ length: n }, (_, i) => open(i + 1))));
    for (let i = 1; i < n; i++) fake.pages.push(nested({ labels: { nodes: [{ name: `l${i}` }], pageInfo: { hasNextPage: false } } }));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'nested_truncated', cursor: null });
    expect(out.issues.filter((i: any) => i.truncated).map((i: any) => i.number)).toEqual([n]);
    expect(out.issues[0].labels).toEqual(['l1']);
    expect(fake.graphqlBodies).toHaveLength(n);
  });

  it('when the follow-up budget runs out on a later page, that page is left for the next call, which reads it whole', async () => {
    const def = snapshotTool();
    const { GITHUB_SNAPSHOT_MAX_NESTED_PAGES } = await import('../../githubIssueSnapshot.js');
    const deep = (n: number) =>
      issue(n, { timelineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `T${n}-0` } } });
    const tail = (n: number, k: number, more: boolean) =>
      nested({ timelineItems: { nodes: [], pageInfo: { hasNextPage: more, endCursor: `T${n}-${k}` } } });
    // Page 1 uses all but one follow-up; page 2 needs two.
    const firstNeeds = GITHUB_SNAPSHOT_MAX_NESTED_PAGES - 1;
    fake.pages.push(page([deep(1)], { hasNextPage: true, endCursor: 'AFTER1' }));
    for (let k = 1; k <= firstNeeds; k++) fake.pages.push(tail(1, k, k < firstNeeds));
    fake.pages.push(page([deep(2)], { hasNextPage: false, endCursor: 'AFTER2' }));
    fake.pages.push(tail(2, 1, true));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'page_limit', cursor: 'AFTER1' });
    expect(out.issues.map((i: any) => i.number)).toEqual([1]);
    expect(out.issues[0].truncated).toBeUndefined();
    expect(out.events.some((e: any) => e.issue === 2)).toBe(false);

    fake.pages.length = 0;
    fake.graphqlBodies.length = 0;
    fake.pages.push(page([deep(2)], { hasNextPage: false, endCursor: 'AFTER2' }));
    fake.pages.push(tail(2, 1, true));
    fake.pages.push(tail(2, 2, false));
    const next = (await def.execute(toolCtx(run), { ...ARGS, cursor: out.cursor })) as Record<string, any>;
    expect(fake.graphqlBodies[0]!.variables.after).toBe('AFTER1');
    expect(next).toMatchObject({ complete: true, cursor: null });
    expect(next.issues.map((i: any) => i.number)).toEqual([2]);
    expect(next.issues[0].truncated).toBeUndefined();
  });

  it('a failed nested follow-up drops that page and resumes at its start, so nothing arrives twice or half', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1)], { hasNextPage: true, endCursor: 'AFTER1' }));
    fake.pages.push(
      page([issue(2), issue(3, { labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'L1' } } })], {
        hasNextPage: false, endCursor: 'AFTER2',
      }),
    );
    fake.pages.push(() => new Response('{}', { status: 429 }));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'rate_limited', cursor: 'AFTER1' });
    expect(out.issues.map((i: any) => i.number)).toEqual([1]);
    expect(out.events.map((e: any) => e.issue)).not.toContain(2);
  });

  it.each([
    ['a null body', raw('null')],
    ['a non-object body', raw('"hello"')],
    ['a null issue node', page([null as never])],
    ['an issue without a number', page([issue(2, { number: 'two' })])],
    ['a null label node', page([issue(2, { labels: { nodes: [null], pageInfo: { hasNextPage: false } } })])],
    ['a sub-issue without a repository', page([issue(2, { subIssues: { nodes: [{ number: 3, repository: null }], pageInfo: { hasNextPage: false } } })])],
    ['a null timeline node', page([issue(2, { timelineItems: { nodes: [null], pageInfo: { hasNextPage: false } } })])],
    ['a parent without a repository', page([issue(2, { parent: { number: 1 } })])],
    ['a nested list with more pages but no cursor', page([issue(2, { labels: { nodes: [], pageInfo: { hasNextPage: true } } })])],
    ['an issue listing with more pages but no cursor', page([issue(2)], { hasNextPage: true, endCursor: null as never })],
    ['an issue listing without pageInfo', page([issue(2)], null as never)],
    ['an issue whose labels have no pageInfo', page([issue(2, { labels: { nodes: [{ name: 'x' }] } })])],
    ['an issue with no timeline connection', page([issue(2, { timelineItems: null })])],
  ])('a malformed second page (%s) keeps page 1 and says github_error with the resume cursor (Glen P3)', async (_label, bad) => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1)], { hasNextPage: true, endCursor: 'AFTER1' }));
    fake.pages.push(bad);
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'github_error', cursor: 'AFTER1' });
    expect(out.issues.map((i: any) => i.number)).toEqual([1]);
  });

  it.each([
    ['no node', null],
    ['the asked-for list missing', {}],
    ['a null label in the list', { labels: { nodes: [null], pageInfo: { hasNextPage: false } } }],
    ['an empty connection (Chip P2)', { labels: {} }],
    ['a connection without nodes', { labels: { pageInfo: { hasNextPage: false } } }],
    ['a connection without pageInfo', { labels: { nodes: [{ name: 'b' }] } }],
    ['a pageInfo without hasNextPage', { labels: { nodes: [{ name: 'b' }], pageInfo: {} } }],
  ])('a malformed nested follow-up (%s) is a github_error that drops the page', async (_label, node) => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1, { labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'L1' } } })]));
    fake.pages.push(nested(node as IssueFixture | null));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out).toMatchObject({ complete: false, incompleteReason: 'github_error', cursor: null, issues: [] });
  });

  it('more pages than one call reads says complete:false (page_limit) with the cursor to continue', async () => {
    const def = snapshotTool();
    for (let i = 0; i < 20; i++) fake.pages.push(page([issue(i + 1)], { hasNextPage: true, endCursor: `C${i + 1}` }));
    const run = await mintRun();
    const out = (await def.execute(toolCtx(run), ARGS)) as Record<string, any>;
    expect(out.complete).toBe(false);
    expect(out.incompleteReason).toBe('page_limit');
    expect(out.cursor).toBe(`C${fake.graphqlBodies.length}`);
    expect(fake.graphqlBodies.length).toBeLessThan(20);
  });
});

describe('github_issue_snapshot: the token never surfaces (#2485 acceptance 6)', () => {
  it('not in the result, the hop trail or the logs, on success', async () => {
    const def = snapshotTool();
    fake.pages.push(page([issue(1)]));
    const run = await mintRun();
    const ctx = toolCtx(run);
    const out = await def.execute(ctx, ARGS);
    expectNoToken(out, ctx.log.mock.calls, await db.appRun.findUnique({ where: { id: run.id } }));
    expect(ctx.log).toHaveBeenCalled();
  });

  it('not in a refusal or an incomplete result', async () => {
    const def = snapshotTool();
    fake.mintPermissions = { issues: 'read', metadata: 'read', contents: 'write' };
    const run = await mintRun();
    const ctx = toolCtx(run);
    const r = await refusal(def.execute(ctx, ARGS));
    fake.mintPermissions = { issues: 'read', metadata: 'read' };
    fake.pages.push(() => new Response(`token ${TOKEN} rejected`, { status: 502 }));
    const out = await def.execute(ctx, ARGS);
    expectNoToken(r, out, ctx.log.mock.calls);
  });
});
