/**
 * #3911 / V71 (cor:agt:040:10): the migration fills a trigger stored with a NULL agent_id from its App's only installed
 * Agent, and DISABLES-and-KEEPS it where the App has several or none (poll bindings, which have no enabled flag, are
 * cancelled and kept). Nothing is deleted; an already-agented row is untouched. Re-enabling a disabled schedule is refused
 * with the V70 refusal until an Agent is named. A trigger naming a hard-deleted Agent fires into the typed refusal, not a 500.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { schedulerTick } from '../../../jobs/scheduler.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../../prisma/migrations/20261121190000_trigger_agent_backfill_3911/migration.sql', import.meta.url)),
  'utf8',
);

let orgId: string;
let adminId: string;
let agentA: string;
let agentB: string;
const ctx = (): Context => ({ db, roles: ['READER'], userId: adminId });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };

async function agent(name: string) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${name}-sys`, urn: `${name}:sys`, organizationId: orgId } });
  const id = (await db.agent.create({ data: { id: generateId(), name, urn: `${name}:agent`, organizationId: orgId, systemMemoryId: mem.id } })).id;
  await serveAgentBootPrompt(db, id, `You are ${name}.`);
  return id;
}
async function app(name: string, installed: string[]) {
  const id = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name, urn: `t3911b::${name}` } })).id;
  for (const agentId of installed) await db.appAgent.create({ data: { appId: id, agentId } as never });
  await db.appMember.create({ data: { appId: id, userId: adminId, role: 'owner' } as never });
  return id;
}
/** A schedule, a webhook and a poll binding on `appId`, all with the given agent (null = the legacy shape). */
async function triggers(appId: string, agentId: string | null) {
  const base = { organizationId: orgId, appId, agentId, userId: adminId, entryNodeUrn: 't3911b::mem::tasks:go' };
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), ...base, name: `s-${generateId().slice(-6)}`, cron: '0 6 * * *', nextRunAt: new Date(Date.now() + 3_600_000) } as never });
  const webhook = await db.agentWebhook.create({ data: { id: generateId(), ...base, name: `w-${generateId().slice(-6)}`, secret: generateId() } as never });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: agentA, triggerKind: 'MANUAL', entryNodeUrn: base.entryNodeUrn, status: 'RUNNING' } as never });
  const poll = await db.webFetchPollBinding.create({ data: { jobId: generateId(), sourceRunId: run.id, organizationId: orgId, appId, agentId, entryNodeUrn: base.entryNodeUrn, url: 'https://example.test/w' } });
  return { schedule: schedule.id, webhook: webhook.id, poll: poll.jobId };
}
const read = async (t: { schedule: string; webhook: string; poll: string }) => ({
  schedule: await db.agentSchedule.findUniqueOrThrow({ where: { id: t.schedule } }),
  webhook: await db.agentWebhook.findUniqueOrThrow({ where: { id: t.webhook } }),
  poll: await db.webFetchPollBinding.findUniqueOrThrow({ where: { jobId: t.poll } }),
});
async function migrate(): Promise<string> {
  const client = new Client({ connectionString: process.env.DATABASE_URL! });
  const notices: string[] = [];
  client.on('notice', n => notices.push(n.message));
  await client.connect();
  try { await client.query(MIGRATION); } finally { await client.end(); }
  return notices.join('\n');
}
const total = async () => (await db.agentSchedule.count()) + (await db.agentWebhook.count()) + (await db.webFetchPollBinding.count());

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 't3911b', urn: 't3911b' } })).id;
  adminId = (await db.user.create({ data: { githubId: 39111, githubUsername: 't3911b-admin', roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  agentA = await agent('alpha');
  agentB = await agent('bravo');
});

describe('#3911 V71: the migration', () => {
  it('one installed Agent: filled from it, enabled stays as it was', async () => {
    const t = await triggers(await app('one', [agentA]), null);
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.webhook.agentId, r.poll.agentId]).toEqual([agentA, agentA, agentA]);
    expect([r.schedule.enabled, r.webhook.enabled, r.poll.cancelledAt]).toEqual([true, true, null]);
  });

  it('several installed: disabled and kept, no Agent chosen for it', async () => {
    const t = await triggers(await app('several', [agentA, agentB]), null);
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.webhook.agentId, r.poll.agentId]).toEqual([null, null, null]);
    expect([r.schedule.enabled, r.webhook.enabled]).toEqual([false, false]);
    expect(r.poll.cancelledAt).not.toBeNull();
  });

  it('none installed: disabled and kept', async () => {
    const t = await triggers(await app('none', []), null);
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.webhook.agentId, r.poll.agentId]).toEqual([null, null, null]);
    expect([r.schedule.enabled, r.webhook.enabled]).toEqual([false, false]);
    expect(r.poll.cancelledAt).not.toBeNull();
  });

  it('a row that already names an Agent is untouched, even in an App with several installed', async () => {
    const t = await triggers(await app('named', [agentA, agentB]), agentB);
    const before = await read(t);
    await migrate();
    const after = await read(t);
    expect(after.schedule).toEqual(before.schedule);
    expect(after.webhook).toEqual(before.webhook);
    expect(after.poll).toEqual(before.poll);
  });

  it('deletes nothing, and reports the counts per kind', async () => {
    await triggers(await app('c-one', [agentA]), null);
    await triggers(await app('c-several', [agentA, agentB]), null);
    await triggers(await app('c-none', []), null);
    await triggers(await app('c-named', [agentA]), agentA);
    const before = await total();
    const report = await migrate();
    expect(await total()).toBe(before);
    expect(report).toContain('schedules filled=1 disabled=2; webhooks filled=1 disabled=2; web_poll_bindings filled=1 cancelled=2');
  });

  it('an Agent that was deleted is not counted as installed', async () => {
    const appId = await app('deleted-second', [agentA, agentB]);
    await db.agent.update({ where: { id: agentB }, data: { deletedAt: new Date() } });
    const t = await triggers(appId, null);
    await migrate();
    expect((await read(t)).schedule.agentId).toBe(agentA);
  });
});

describe('#3911 V71: re-enabling a disabled schedule', () => {
  const enable = (id: string, extra: Record<string, unknown> = {}) =>
    M.updateAgentSchedule({}, { id, input: { enabled: true, ...extra } }, ctx());

  it('several installed: refused with RUN_AGENT_REQUIRED until an Agent is named, then allowed', async () => {
    const t = await triggers(await app('re-several', [agentA, agentB]), null);
    await migrate();
    expect(await code(enable(t.schedule))).toBe('RUN_AGENT_REQUIRED');
    expect((await read(t)).schedule.enabled).toBe(false);
    await enable(t.schedule, { agentRef: agentB });
    const r = (await read(t)).schedule;
    expect([r.enabled, r.agentId]).toEqual([true, agentB]);
  });

  it('none installed: refused with BOOT_PROMPT_NOT_SET, then allowed once an Agent is installed and named', async () => {
    const appId = await app('re-none', []);
    const t = await triggers(appId, null);
    await migrate();
    expect(await code(enable(t.schedule))).toBe('BOOT_PROMPT_NOT_SET');
    expect(await code(enable(t.schedule, { agentRef: agentA }))).toBe('BAD_USER_INPUT');
    await db.appAgent.create({ data: { appId, agentId: agentA } as never });
    await enable(t.schedule, { agentRef: agentA });
    expect((await read(t)).schedule.enabled).toBe(true);
  });

  it('a schedule that names an Agent re-enables as before', async () => {
    const t = await triggers(await app('re-named', [agentA, agentB]), agentA);
    await db.agentSchedule.update({ where: { id: t.schedule }, data: { enabled: false } });
    await enable(t.schedule);
    expect((await read(t)).schedule.enabled).toBe(true);
  });
});

describe('#3911: a trigger naming a hard-deleted Agent', () => {
  it('a due schedule is a logged denial (the launch gate answers AGENT_NOT_INSTALLED): no run, no internal error', async () => {
    const t = await triggers(await app('dangling', [agentA]), generateId());
    await db.agentSchedule.update({ where: { id: t.schedule }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runsBefore = await db.appRun.count({ where: { triggerKind: 'SCHEDULE' } });
    expect(await schedulerTick(db)).toBe(0);
    expect(await db.appRun.count({ where: { triggerKind: 'SCHEDULE' } })).toBe(runsBefore);
    expect(warn.mock.calls.flat().join(' ')).toContain('AGENT_NOT_INSTALLED');
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore(); error.mockRestore();
  });
});
