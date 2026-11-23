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
  client.on('notice', n => notices.push(String(n.message)));
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

describe('#3911 V71: the imports half of "installed"', () => {
  async function imp(parent: string, child: string) {
    await db.agentOrgGrant.create({ data: { orgId, agentId: child, activatedAt: new Date() } });
    await db.agentImport.create({ data: { parentAgentId: parent, importedAgentId: child, position: 1, required: true, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: child } });
  }
  it('a physical install plus an Agent it imports are two installed Agents: disabled, not filled', async () => {
    const appId = await app('imp-two', [agentA]);
    await imp(agentA, agentB);
    const t = await triggers(appId, null);
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.schedule.enabled]).toEqual([null, false]);
    expect([r.webhook.agentId, r.webhook.enabled]).toEqual([null, false]);
  });
  it('an imported Agent that was deleted is not counted: filled from the physical install', async () => {
    const appId = await app('imp-deleted', [agentA]);
    await imp(agentA, agentB);
    await db.agent.update({ where: { id: agentB }, data: { deletedAt: new Date() } });
    const t = await triggers(appId, null);
    await migrate();
    expect((await read(t)).schedule.agentId).toBe(agentA);
  });
  it('an install on a deleted App is not counted: the live install fills', async () => {
    const live = await app('app-live', [agentA]);
    const t = await triggers(live, null);
    const dead = await app('app-dead', [agentB]);
    await db.app.update({ where: { id: dead }, data: { deletedAt: new Date() } });
    await migrate();
    expect((await read(t)).schedule.agentId).toBe(agentA);
  });
  // #4835 pin 2 — the physical branch's `JOIN apps` discrimination. The test above hosts the deleted App as an UNUSED
  // install elsewhere, so it holds with or without the join. Here the trigger's OWN App is gone: it has no installed
  // Agent (V71: "its App's single installed Agent"), so the row is DISABLED and KEPT, never filled from the App's
  // (still listed) app_agents row. Dropping `ap.deleted_at IS NULL` or `ap.uninstalled_at IS NULL` from the physical
  // branch's `JOIN apps` fills it instead. Each clause is pinned by its own App. The rows start enabled (schedule,
  // webhook) and uncancelled (poll), so the disable arm has work to do and "disabled" is a real transition.
  it.each([
    ['deleted', { deletedAt: new Date() }],
    ['uninstalled', { uninstalledAt: new Date() }],
  ])('the trigger\'s own App is %s: disabled and kept, not filled from its app_agents row (#4835)', async (label, gone) => {
    const appId = await app(`own-${label}`, [agentA]);
    const t = await triggers(appId, null);
    await db.app.update({ where: { id: appId }, data: gone });
    const before = await total();
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.schedule.enabled]).toEqual([null, false]);
    expect([r.webhook.agentId, r.webhook.enabled]).toEqual([null, false]);
    expect(r.poll.agentId).toBeNull();
    expect(r.poll.cancelledAt).not.toBeNull();
    // Nothing is deleted: V71's last sentence. The rows, their App row and the run history survive.
    expect(await total()).toBe(before);
    expect(r.schedule.deletedAt).toBeNull();
    expect(r.webhook.deletedAt).toBeNull();
    expect(await db.app.count({ where: { id: appId } })).toBe(1); // the App row itself (deleted or uninstalled) is kept
  });

  // #4835 (LOCAL P3) — the IMPORTS branch has its own `apps` and `organizations` joins, so the physical-branch pin above does
  // not reach them. The trigger's own App deleted or uninstalled, with an Agent installed that imports another: the physical
  // branch excludes the App, so only the imports branch could credit the imported Agent, and it must not (disabled, not
  // filled). Dropping `ap.deleted_at` / `ap.uninstalled_at` from the imports branch fills it with the imported Agent.
  it.each([
    ['deleted', { deletedAt: new Date() }],
    ['uninstalled', { uninstalledAt: new Date() }],
  ])('the trigger\'s own App is %s and an installed Agent imports another: disabled, not filled from the import (#4835)', async (label, gone) => {
    const appId = await app(`own-imp-${label}`, [agentA]);
    await imp(agentA, agentB);
    const t = await triggers(appId, null);
    await db.app.update({ where: { id: appId }, data: gone });
    const before = await total();
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.schedule.enabled]).toEqual([null, false]);
    expect([r.webhook.agentId, r.webhook.enabled]).toEqual([null, false]);
    expect(r.poll.agentId).toBeNull();
    expect(r.poll.cancelledAt).not.toBeNull();
    expect(await total()).toBe(before); // nothing deleted
  });

  // The organization clause of the imports branch: with the owning organization deleted the import is not credited, so the
  // physical install alone is the only installed Agent and fills the trigger. Dropping `o.deleted_at IS NULL` credits the
  // import too (two installed Agents) and disables it instead. The asymmetry (a physical install is credited under a deleted
  // organization, an import is not) is written in the migration's own header ("...as imports ... in a live, org-owned App")
  // and mirrors `resolveAppInstallation` (src/lib/appInstallations.ts: physical rows are listed first, then the import loop is
  // skipped when the organization is deleted). CURRENT BEHAVIOUR, UNCONFIRMED AGAINST SPEC: V71 says "installed" without
  // saying whether an import counts under a deleted organization, so this pins what ships, not a confirmed rule (Vera has
  // been asked to check it against the corpus; a follow-up issue only if she calls it a defect).
  it('the owning organization is deleted: an import is not credited, so the physical install alone fills (#4835)', async () => {
    const appId = await app('org-gone', [agentA]);
    await imp(agentA, agentB);
    const t = await triggers(appId, null);
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.schedule.enabled]).toEqual([agentA, true]);
  });

  // #4835 pin 3 — an import counts only THROUGH its live importer (the imports branch joins the importing Agent with
  // `deleted_at IS NULL`; appInstallations.ts filters importers the same way). With the physical install's Agent deleted
  // and its import edge still live, neither branch credits the App: disabled, NOT filled with the imported Agent, and
  // nothing deleted. Dropping the importer-live join would credit the imported Agent and fill from it.
  it('the importer is deleted but its import edge is live: disabled, not filled from the import (#4835)', async () => {
    const appId = await app('imp-importer-deleted', [agentA]);
    await imp(agentA, agentB);
    await db.agent.update({ where: { id: agentA }, data: { deletedAt: new Date() } });
    const t = await triggers(appId, null);
    const before = await total();
    await migrate();
    const r = await read(t);
    expect([r.schedule.agentId, r.schedule.enabled]).toEqual([null, false]);
    expect([r.webhook.agentId, r.webhook.enabled]).toEqual([null, false]);
    expect(r.poll.agentId).toBeNull();
    expect(r.poll.cancelledAt).not.toBeNull();
    expect(await total()).toBe(before);
    expect(await db.agentImport.count({ where: { parentAgentId: agentA, importedAgentId: agentB } })).toBe(1);
  });

  it('a fill and a disable stamp updated_at, and a second run changes nothing', async () => {
    const t = await triggers(await app('stamp', [agentA]), null);
    const before = await read(t);
    await migrate();
    const once = await read(t);
    expect(once.schedule.updatedAt!.getTime()).toBeGreaterThan(before.schedule.updatedAt!.getTime());
    expect(once.webhook.updatedAt!.getTime()).toBeGreaterThan(before.webhook.updatedAt!.getTime());
    expect(await migrate()).toContain('schedules filled=0 disabled=0; webhooks filled=0 disabled=0; web_poll_bindings filled=0 cancelled=0');
    expect(await read(t)).toEqual(once);
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

  it('clearing the Agent of an ENABLED schedule is refused the same way (agentRef: null no longer recreates a null-agent enabled row)', async () => {
    const t = await triggers(await app('clear-several', [agentA, agentB]), agentA);
    expect(await code(M.updateAgentSchedule({}, { id: t.schedule, input: { agentRef: null } }, ctx()))).toBe('RUN_AGENT_REQUIRED');
    expect(await code(M.updateAgentSchedule({}, { id: t.schedule, input: { agentRef: null, enabled: true } }, ctx()))).toBe('RUN_AGENT_REQUIRED');
    const r = (await read(t)).schedule;
    expect([r.agentId, r.enabled]).toEqual([agentA, true]);
  });

  it('clearing the Agent together with enabled: false is allowed (the V71 state)', async () => {
    const t = await triggers(await app('clear-off', [agentA, agentB]), agentA);
    await M.updateAgentSchedule({}, { id: t.schedule, input: { agentRef: null, enabled: false } }, ctx());
    const r = (await read(t)).schedule;
    expect([r.agentId, r.enabled]).toEqual([null, false]);
  });

  // #4835 pin 1 — the SUCCESS branch of an `agentRef: null` edit of an ENABLED schedule: with exactly one installed Agent
  // the edit is judged as a creation is (V70 resolution) and records that Agent instead of clearing; every refusal test
  // above uses an App with several or none. The start state is reachable by uninstalling an Agent: the App had two installed Agents,
  // the schedule names agentB, and agentB's install row is then removed (done directly here, not through the uninstall door),
  // leaving agentA the only one. A reading that preserved the
  // named Agent, or that cleared to null, would not end [agentA, true]. This pins the builder's reading of V70's
  // resolution (record the single installed Agent); cor:api:210:01's "explicit null is treated as absent" could be read
  // against it and the corpus does not state which holds (Vera records the reading as Proposed on merge).
  it('clearing the Agent of an enabled schedule in an App with ONE installed Agent records that Agent (#4835)', async () => {
    const appId = await app('clear-one', [agentA, agentB]);
    const t = await triggers(appId, agentB);
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId: agentB } } });
    const returned = await M.updateAgentSchedule({}, { id: t.schedule, input: { agentRef: null } }, ctx());
    expect([returned.agentId, returned.enabled]).toEqual([agentA, true]);
    const r = (await read(t)).schedule;
    expect([r.agentId, r.enabled]).toEqual([agentA, true]);
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
