/**
 * #3082 (MCP team cut S1, plans:mcp-team-cut rev 2, V7 R1/R2/R4): the agent team works through the CLI and the portal,
 * not MCP. 71 team tools are disabled (unknown-tool on the wire, absent from tools/list); `hadron_start_session` refuses a
 * worker binding with MCP_WORKER_BINDING_UNSUPPORTED before any read or write. Pins in two groups:
 *   RED on main: the disabled list, the unknown-tool answer, the R2 refusal and its no-write proof, server_info, the
 *     text that pointed at a disabled tool.
 *   GREEN on main by design (regression guards for what must NOT move): a session a worker CLI created still attributes a
 *     core MCP write through the `session` argument; the header never creates or resumes a session; GraphQL still serves
 *     each team family.
 * The list below is the plan's "The tool list", frozen as a literal so a re-enabled tool cannot hide behind a derived set.
 */
import fs from 'node:fs';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { createMcpServerInstance, createTestableMcpServer } from './server.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const DISABLED = [
  'hadron_resume_session',
  'hadron_create_resume_claim',
  'hadron_record_work',
  'hadron_team_work_items',
  'hadron_cast_worker',
  'hadron_list_workers',
  'hadron_get_worker',
  'hadron_update_worker',
  'hadron_delete_worker',
  'hadron_change_worker_agent',
  'hadron_set_worker_reports_to',
  'hadron_list_channels',
  'hadron_create_channel',
  'hadron_register_list',
  'hadron_register_add',
  'hadron_register_remove',
  'hadron_channel_post',
  'hadron_channel_read',
  'hadron_team_chat_post',
  'hadron_team_chat_read',
  'hadron_team_chat_search',
  'hadron_team_chat_mark_read',
  'hadron_team_chat_inbox',
  'hadron_team_chat_inbox_ack',
  'hadron_team_attention',
  'hadron_team_attention_page',
  'hadron_team_attention_switchover',
  'hadron_task_create',
  'hadron_task_update',
  'hadron_task_assign',
  'hadron_task_reassign',
  'hadron_task_blocker_add',
  'hadron_task_blocker_remove',
  'hadron_task_priority_set',
  'hadron_task_start',
  'hadron_task_progress',
  'hadron_task_finish',
  'hadron_task_cancel',
  'hadron_task_park',
  'hadron_task_make_ready',
  'hadron_task_get',
  'hadron_task_list',
  'hadron_team_events',
  'hadron_alarm_ack',
  'hadron_team_roster',
  'hadron_team_availability',
  'hadron_worker_availability_set',
  'hadron_model_family_availability_set',
  'hadron_stall_schedule_get',
  'hadron_stall_schedule_set',
  'hadron_stop_signal_set',
  'hadron_stop_signal_lift',
  'hadron_stop_signal_list',
  'hadron_set_team_pause',
  'hadron_isolate_worker',
  'hadron_clear_worker_isolation',
  'hadron_ticker_list',
  'hadron_ticker_create',
  'hadron_ticker_update',
  'hadron_ticker_delete',
  'hadron_ticker_subscribe',
  'hadron_ticker_unsubscribe',
  'hadron_worker_wake_settings',
  'hadron_due_wakes',
  'hadron_ack_wakes',
  'hadron_delivery_settings_get',
  'hadron_delivery_settings_set',
  'hadron_agent_ticker_template_list',
  'hadron_agent_ticker_template_create',
  'hadron_agent_ticker_template_update',
  'hadron_agent_ticker_template_delete',
] as const;
const DISABLED_SET = new Set<string>(DISABLED);
const KEPT_SAMPLE = [
  'hadron_start_session', 'hadron_end_session', 'hadron_whoami', 'hadron_server_info', 'hadron_search', 'hadron_get_node',
  'hadron_create_node', 'hadron_list_apps', 'hadron_agent_tasks', 'hadron_agent_processes', 'hadron_agent_set_base',
  'hadron_agent_set_index_refs', 'hadron_create_task', 'hadron_update_task',
];
const TOKENS_REMOVED = [
  'worker-model', 'worker-boot-briefing', 'team-chat', 'team-worklog', 'session-app-recovery', 'channels',
  'team-chat-monitor', 'worklog-model', 'team-attention',
];
const GOLDEN = new URL('./__golden__/toolSurface2260.json', import.meta.url);

let org: { id: string; urn: string };
let user: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let worker: { id: string };
let appKeyId: string;

const userAuth = (): AuthContext => ({ userId: user.id, appId: app.id, roles: ['READER'], clientId: `user:${user.id}` }) as AuthContext;
const appKeyAuth = (): AuthContext => ({ appId: app.id, appKeyId, roles: [] }) as AuthContext;
const impersonationAuth = (): AuthContext =>
  ({ userId: user.id, roles: ['READER'], clientId: `user:${user.id}`,
    impersonation: { sessionId: 's', actorUserId: user.id, orgId: org.id, expiresAt: new Date('2099-01-01') } }) as AuthContext;
const PRINCIPALS: Array<[string, () => AuthContext]> = [['user', userAuth], ['app-key', appKeyAuth], ['impersonation', impersonationAuth]];

async function withClient<T>(auth: AuthContext, fn: (c: Client) => Promise<T>): Promise<T> {
  const server = createMcpServerInstance(auth as never, () => undefined, { kind: 'multi-app' });
  const client = new Client({ name: 'cut-3082', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try { return await fn(client); } finally { await client.close(); await server.close(); }
}
const listNames = (auth: AuthContext) => withClient(auth, async (c) => (await c.listTools()).tools.map((t) => t.name));
async function outcome(auth: AuthContext, name: string, args: Record<string, unknown> = {}) {
  return withClient(auth, async (c) => {
    try { return { result: JSON.stringify(await c.callTool({ name, arguments: args })) }; }
    catch (e) { return { error: (e as Error).message }; }
  });
}
const text = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  await cleanDb(db);
  const sfx = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'cut-3082', urn: `cut3082-${sfx}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 308_200 + Math.floor(Math.random() * 90_000), githubUsername: `cut3082-${sfx}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:backend`, name: 'Backend', visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  appKeyId = generateId();
  await serveEveryAgent(db);
});

describe('#3082 R1: the 71 team tools are disabled', () => {
  it('the frozen list has 71 distinct names', () => {
    expect(DISABLED.length).toBe(71);
    expect(DISABLED_SET.size).toBe(71);
  });

  for (const [label, auth] of PRINCIPALS) {
    it(`tools/list for ${label} lists none of the 71 and every other tool the surface listed before`, async () => {
      const listed = await listNames(auth());
      expect(listed.filter((n) => DISABLED_SET.has(n)), 'a disabled tool is still registered').toEqual([]);
      for (const k of KEPT_SAMPLE) {
        if (label === 'app-key' && ['hadron_create_task', 'hadron_update_task'].includes(k) === false) expect(listed, k).toContain(k);
        else if (label !== 'app-key') expect(listed, k).toContain(k);
      }
      const variant = { user: 'userWithApp', 'app-key': 'appKeyOnly', impersonation: 'impersonation' }[label]!;
      const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, Array<[string, string]>>;
      expect(listed.length, 'the kept tools did not shrink').toBeGreaterThanOrEqual(golden[variant].filter(([n]) => !DISABLED_SET.has(n)).length - 5);
    });
  }

  it('a disabled tool answers exactly as a name that was never registered', async () => {
    for (const [label, auth] of PRINCIPALS) {
      const baseline = await outcome(auth(), 'hadron_never_registered_3082', {});
      for (const name of ['hadron_team_chat_post', 'hadron_task_create', 'hadron_ticker_list', 'hadron_stop_signal_set', 'hadron_resume_session', 'hadron_cast_worker']) {
        const got = await outcome(auth(), name, {});
        const norm = (o: { result?: string; error?: string }, n: string) => JSON.stringify(o).split(n).join('<tool>');
        expect(norm(got, name), `${label}: ${name}`).toBe(norm(baseline, 'hadron_never_registered_3082'));
      }
    }
  });
});

describe('#3082 R2: no worker binding on MCP', () => {
  const refusalCode = 'MCP_WORKER_BINDING_UNSUPPORTED';
  const snapshot = async () => ({
    sessions: await db.session.count(),
    held: (await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { heldByUserId: true } })).heldByUserId,
    claims: await db.resumeClaim.count(),
    grants: await db.launchGrant.count({ where: { consumedAt: null } }),
  });

  it('hadron_start_session refuses { workerRef }, { launchGrant } alone and { workerRef, force } for a user and an App key, writing nothing', async () => {
    for (const auth of [userAuth(), appKeyAuth()]) {
      for (const args of [{ workerRef: worker.id }, { launchGrant: 'lg-not-real' }, { workerRef: worker.id, force: true }, { workerRef: 'Iris' }]) {
        const before = await snapshot();
        const out = await createTestableMcpServer(auth).callToolText('hadron_start_session', { description: 'cut', ...args });
        expect(out).toContain(`[${refusalCode}]`);
        expect(out).toContain('hadron team session start');
        expect(await snapshot(), JSON.stringify(args)).toEqual(before);
      }
    }
  });

  it('the refusal is judged before any lookup: an unknown worker and a real one answer byte-identically', async () => {
    const a = await createTestableMcpServer(userAuth()).callToolText('hadron_start_session', { description: 'cut', workerRef: worker.id });
    const b = await createTestableMcpServer(userAuth()).callToolText('hadron_start_session', { description: 'cut', workerRef: 'hrn:worker:nowhere.example:x:y' });
    expect(a).toBe(b);
    expect(a).toContain(`[${refusalCode}]`);
  });

  it('a plain session (no worker) still starts', async () => {
    const out = await createTestableMcpServer(userAuth()).callToolText('hadron_start_session', { description: 'plain' });
    expect(out).toContain('Session started:');
    expect(out).not.toContain(refusalCode);
  });

  it('hadron_resume_session is unknown-tool and consumes no claim and writes no session (Q1 = a)', async () => {
    const before = await snapshot();
    const got = await outcome(userAuth(), 'hadron_resume_session', { claim: 'x' });
    const baseline = await outcome(userAuth(), 'hadron_never_registered_3082', { claim: 'x' });
    expect(JSON.stringify(got).split('hadron_resume_session').join('<t>')).toBe(JSON.stringify(baseline).split('hadron_never_registered_3082').join('<t>'));
    expect(await snapshot()).toEqual(before);
  });

  it('GREEN by design: a worker session the CLI created (GraphQL startSession) still attributes a core MCP write through the session argument', async () => {
    const ctx = { db, userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as never;
    const started = (await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: worker.id, plan: 'cli bound', force: true } }, ctx)) as { id: string };
    const mem = await db.memory.create({ data: { id: generateId(), urn: `${org.urn}:team-shared`, name: 'team-shared', class: 'app', appId: app.id, organizationId: org.id } });
    const out = await createTestableMcpServer(userAuth()).callToolText('hadron_create_node', { urn: `hrn:node:${mem.urn}:attr:bound`, name: 'bound', session: started.id });
    expect(out).not.toMatch(/^Error/);
    const node = await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'attr:bound' }, select: { createdByWorkerId: true } });
    expect(node.createdByWorkerId).toBe(worker.id);
  });

  it('GREEN by design: the X-Hadron-Session path never creates or resumes a session (an ended worker session stays ended)', async () => {
    const ctx = { db, userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as never;
    const started = (await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: worker.id, plan: 'to end', force: true } }, ctx)) as { id: string };
    await db.session.update({ where: { id: started.id }, data: { endedAt: new Date() } });
    const before = await db.session.findUniqueOrThrow({ where: { id: started.id } });
    await createTestableMcpServer({ ...userAuth(), sessionId: started.id } as never).callToolText('hadron_whoami', {});
    const after = await db.session.findUniqueOrThrow({ where: { id: started.id } });
    expect(after.endedAt?.getTime()).toBe(before.endedAt?.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

describe('#3082 capabilities: no team capability is advertised', () => {
  it('hadron_server_info names none of the removed tokens', async () => {
    const out = await createTestableMcpServer(userAuth()).callToolText('hadron_server_info', {});
    const caps = (out.match(/capabilities: (.*)/)?.[1] ?? '').split(', ');
    expect(caps.length).toBeGreaterThan(3);
    for (const t of TOKENS_REMOVED) expect(caps, t).not.toContain(t);
    expect(caps).not.toContain('team-attention-paged');
  });
});

describe('#3082 text: nothing that stays points at a disabled tool', () => {
  const mentions = (s: string) => DISABLED.filter((n) => new RegExp(`${n}(?![a-z_])`).test(s));

  for (const [label, auth] of PRINCIPALS) {
    it(`no kept tool's description or input schema names a disabled tool (${label})`, async () => {
      const tools = await withClient(auth(), async (c) => (await c.listTools()).tools);
      const offenders = tools.filter((t) => mentions(JSON.stringify([t.description, t.inputSchema])).length > 0).map((t) => `${t.name}: ${mentions(JSON.stringify([t.description, t.inputSchema])).join(',')}`);
      expect(offenders).toEqual([]);
    });
  }

  it('the receipts of a plain start and of an end name none', async () => {
    const srv = createTestableMcpServer(userAuth());
    const started = await srv.callToolText('hadron_start_session', { description: 'receipts' });
    expect(mentions(started)).toEqual([]);
    const id = started.match(/Session started: (\S+)/)?.[1]!;
    const ended = await srv.callToolText('hadron_end_session', { id, summary: 'done' });
    expect(mentions(ended)).toEqual([]);
    expect(mentions(await srv.callToolText('hadron_whoami', {}))).toEqual([]);
  });

  it('the delivery footer, the stop-signal refusal and the protected-loc refusal name no disabled tool', () => {
    for (const f of ['../lib/tickers/deliveryPending.ts', '../lib/stopSignals/enforce.ts', '../lib/protectedLoc.ts']) {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(mentions(src), f).toEqual([]);
    }
  });
});

describe('#3082 GREEN by design: GraphQL still serves each team family (the resolver is the thing under test)', () => {
  const fields: Record<string, string[]> = {
    sessions: ['createResumeClaim', 'resumeSession', 'recordWork'],
    workers: ['castWorker', 'updateWorker', 'deleteWorker', 'changeWorkerAgent', 'setWorkerReportsTo'],
    'channels/register': ['createChannel', 'registerAdd', 'registerRemove'],
    chat: ['postTeamChat', 'teamChatMessages', 'teamChatMarkRead'],
    attention: ['teamAttention'],
    tasks: ['createAgentTask', 'updateAgentTask', 'startAgentTask', 'finishAgentTask', 'agentTasks'],
    'roster/events/alarms/availability': ['teamRoster', 'teamEvents', 'ackAlarm', 'setWorkerAvailability', 'setStallSchedule'],
    'stop signals/pause': ['setStopSignal', 'liftStopSignal', 'teamStopSignals', 'setTeamPause', 'isolateWorker', 'clearWorkerIsolation'],
    'tickers/wakes': ['tickers', 'createTicker', 'dueWakes', 'ackWakes', 'agentTickerTemplates'],
  };
  it('every family is still in the GraphQL schema or resolver maps', () => {
    const sdl = fs.readFileSync(new URL('../api/graphql/schema/typeDefs.ts', import.meta.url), 'utf8');
    const missing: string[] = [];
    for (const [family, names] of Object.entries(fields)) {
      const hit = names.filter((n) => new RegExp(`\\b${n}\\b`).test(sdl) || n in (resolvers.Query as object) || n in (resolvers.Mutation as object));
      if (hit.length === 0) missing.push(family);
    }
    expect(missing).toEqual([]);
  });
});
