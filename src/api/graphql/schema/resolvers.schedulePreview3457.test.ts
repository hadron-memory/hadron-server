/**
 * #3457 (AT0.4674, Refs #2435): previewAgentSchedule shows what a schedule will
 * do before it exists. Red first: every case fails on main, where no such read
 * exists. The pin is built by the same call createAgentSchedule uses, so the
 * hash a preview returns is the hash the created schedule's approval shows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { automationPinQueries } from './resolvers.automationPin.js';
import { appRunMutations, appRunQueries } from './resolvers.appRun.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

const preview = (appRunQueries as any).previewAgentSchedule as (_: unknown, a: { input: Record<string, unknown> }, ctx: unknown) => Promise<any>;

async function fixture() {
  const user = await db.user.create({ data: { handle: 'sp-admin' } });
  const org = await db.organization.create({ data: { name: 'Sp', urn: 'sp.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Sp', urn: 'sp.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'sp.test:flow', class: 'knowledge', organizationId: org.id } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Weekly report', isRunnable: true, content: 'approved', data: { tools: ['web_search'] } } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'sp.test:runner', name: 'runner' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const member = await db.user.create({ data: { handle: 'sp-member' } });
  await db.orgMember.create({ data: { userId: member.id, organizationId: org.id, role: 'CONTRIBUTOR' } });
  const otherOrg = await db.organization.create({ data: { name: 'Other', urn: 'other.test' } });
  const outsider = await db.user.create({ data: { handle: 'sp-outsider' } });
  await db.orgMember.create({ data: { userId: outsider.id, organizationId: otherOrg.id, role: 'ADMIN' } });
  const ctx = { db, userId: user.id, roles: [] as never[] };
  const input = { appRef: app.id, cron: '0 9 * * 1', timezone: 'Europe/Berlin', entryNodeUrn: 'hrn:node:sp.test:flow:entry', runAsSelf: true, agentRef: agent.id };
  return { user, org, app, memory, entry, agent, ctx, input,
    memberCtx: { db, userId: member.id, roles: [] as never[] }, outsiderCtx: { db, userId: outsider.id, roles: [] as never[] } };
}
type F = Awaited<ReturnType<typeof fixture>>;
const counts = async (appId: string) => ({
  schedules: await db.agentSchedule.count(),
  runs: await db.appRun.count(),
  events: await db.automationAdoptionEvent.count({ where: { appId } }),
});
const create = (f: F, input: Record<string, unknown> = f.input, ctx: unknown = f.ctx) =>
  appRunMutations.createAgentSchedule({}, { input: { name: 'Weekly', ...input } as never }, ctx as never);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ code: e.extensions?.code, message: e.message }));

describe('#3457 previewAgentSchedule: what the schedule will do, with no row', () => {
  it('Acc.1/2: an org admin gets the summary and hash, and nothing is written', async () => {
    const f = await fixture();
    const before = await counts(f.app.id);
    const out = await preview({}, { input: f.input }, f.ctx);
    expect(out.outcome).toBe('ADOPTABLE');
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.reason).toBeNull();
    expect(out.summary.name).toBe('Weekly report');
    expect(out.summary.tools).toEqual(['web_search']);
    expect(out.summary.schedule).toContain('0 9 * * 1');
    expect(await counts(f.app.id)).toEqual(before);
    expect(before).toEqual({ schedules: 0, runs: 0, events: 0 });
  });

  it('Acc.3: a schedule created straight after has the previewed hash, ADOPTED, and the same summary', async () => {
    const f = await fixture();
    const out = await preview({}, { input: f.input }, f.ctx);
    const schedule = await create(f);
    const approval = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: schedule.id }, f.ctx);
    expect(approval.state).toBe('ADOPTED');
    expect(approval.hash).toBe(out.hash);
    expect(approval.summary).toEqual(out.summary);
  });

  it('Acc.3: the same inputs the pin depends on give the same hash (runAsSelf false, AI-config name)', async () => {
    const f = await fixture();
    for (const extra of [{ aiConfigName: 'nope' }, { eventData: { __aiConfigName: 'x' } }, { enabled: false, budgetTokens: 1000 }]) {
      const input = { ...f.input, ...extra };
      const out = await preview({}, { input }, f.ctx);
      const schedule = await create(f, input);
      const approval = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: schedule.id }, f.ctx);
      expect(approval.hash).toBe(out.hash);
    }
    // A run with no user cannot reach this unattached memory: preview and create agree it cannot be adopted.
    const noUser = { ...f.input, runAsSelf: false };
    expect(await preview({}, { input: noUser }, f.ctx)).toMatchObject({ outcome: 'CANNOT_BE_ADOPTED', reason: 'MEMORY_UNREADABLE' });
    expect(((await create(f, noUser)).automationPin as any).format).toBe('hadron-automation-unadopted-v1');
  });

  it('Acc.4: the preview is a snapshot, so a graph change before create changes the hash', async () => {
    const f = await fixture();
    const out = await preview({}, { input: f.input }, f.ctx);
    await db.node.update({ where: { id: f.entry.id }, data: { content: 'changed after preview' } });
    const schedule = await create(f);
    const approval = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: schedule.id }, f.ctx);
    expect(approval.hash).not.toBe(out.hash);
  });

  it('Acc.5: the admin gate runs first and refuses exactly as create does, before any node or Agent read', async () => {
    const f = await fixture();
    const probes = [
      { ...f.input },
      { ...f.input, entryNodeUrn: 'hrn:node:sp.test:flow:missing' },
      { ...f.input, agentRef: 'not-an-agent' },
      { ...f.input, cron: 'garbage' },
    ];
    for (const ctx of [f.memberCtx, f.outsiderCtx]) {
      for (const input of probes) {
        const expected = await refusal(create(f, input, ctx));
        expect(expected?.code).toBe('FORBIDDEN');
        expect(await refusal(preview({}, { input }, ctx))).toEqual(expected);
      }
    }
    const unknownApp = { ...f.input, appRef: generateId() };
    const expected = await refusal(create(f, unknownApp));
    expect(expected).not.toBeNull();
    expect(await refusal(preview({}, { input: unknownApp }, f.ctx))).toEqual(expected);
    expect(await counts(f.app.id)).toEqual({ schedules: 0, runs: 0, events: 0 });
  });

  it('refuses a bad Agent and bad timing as create does', async () => {
    const f = await fixture();
    for (const patch of [{ agentRef: 'not-an-agent' }, { cron: 'garbage' }, { cron: undefined, runAt: undefined }, { runAt: '2030-01-01T00:00:00Z' }, { cron: undefined, runAt: 'nope' }, { entryNodeUrn: 'entry' }]) {
      const input = { ...f.input, ...patch };
      const expected = await refusal(create(f, input));
      expect(expected).not.toBeNull();
      expect(await refusal(preview({}, { input }, f.ctx))).toEqual(expected);
    }
  });

  it('Acc.6: a missing entry and an unreadable one answer identically, with no content', async () => {
    const f = await fixture();
    const someone = await db.user.create({ data: { handle: 'sp-someone' } });
    const secret = await db.memory.create({ data: { name: 'Secret', urn: 'sp.test:secret', class: 'personal', userId: someone.id, organizationId: f.org.id } });
    await db.node.create({ data: { memoryId: secret.id, loc: 'entry', name: 'TOP SECRET NAME', isRunnable: true, content: 'TOP SECRET BODY' } });
    const missing = await preview({}, { input: { ...f.input, entryNodeUrn: 'hrn:node:sp.test:flow:nothing-here' } }, f.ctx);
    const unreadable = await preview({}, { input: { ...f.input, entryNodeUrn: 'hrn:node:sp.test:secret:entry' } }, f.ctx);
    expect(unreadable).toEqual(missing);
    expect(JSON.stringify(unreadable)).not.toContain('SECRET');
    expect(missing.outcome).toBe('CANNOT_BE_ADOPTED');
    expect(missing.reason).toBe('MEMORY_UNREADABLE');
    expect(missing.hash).toBeNull();
    expect(missing.summary).toBeNull();
  });

  it('Acc.7: an encrypted entry the caller can read is a typed result (reason OTHER), the same one create stores as UNADOPTED', async () => {
    const f = await fixture();
    await db.memory.update({ where: { id: f.memory.id }, data: { isEncrypted: true } });
    const out = await preview({}, { input: f.input }, f.ctx);
    expect(out).toMatchObject({ outcome: 'CANNOT_BE_ADOPTED', reason: 'OTHER', hash: null, summary: null });
    const schedule = await create(f);
    expect((schedule.automationPin as any).format).toBe('hadron-automation-unadopted-v1');
    expect((schedule.automationPin as any).reason).toBeUndefined();
  });

  it('Acc.7: an entry over the pin bounds is the typed result, not an error', async () => {
    const f = await fixture();
    // 201 partials chained from the entry exceed the 200-reference bound.
    const body = Array.from({ length: 201 }, (_, i) => `{{> p${i}}}`).join('\n');
    await db.node.update({ where: { id: f.entry.id }, data: { content: body } });
    const out = await preview({}, { input: f.input }, f.ctx);
    expect(out).toMatchObject({ outcome: 'CANNOT_BE_ADOPTED', reason: 'OTHER', hash: null, summary: null });
    const schedule = await create(f);
    expect((schedule.automationPin as any).format).toBe('hadron-automation-unadopted-v1');
  });

  it('Acc.6/7 both ways: OTHER is reached only for an entry the caller can read', async () => {
    const f = await fixture();
    const someone = await db.user.create({ data: { handle: 'sp-someone2' } });
    const secret = await db.memory.create({ data: { name: 'Enc', urn: 'sp.test:enc', class: 'personal', userId: someone.id, organizationId: f.org.id, isEncrypted: true } });
    await db.node.create({ data: { memoryId: secret.id, loc: 'entry', name: 'x', isRunnable: true, content: 'y' } });
    const unreadableEncrypted = await preview({}, { input: { ...f.input, entryNodeUrn: 'hrn:node:sp.test:enc:entry' } }, f.ctx);
    const missing = await preview({}, { input: { ...f.input, entryNodeUrn: 'hrn:node:sp.test:flow:nothing-here' } }, f.ctx);
    expect(unreadableEncrypted).toEqual(missing);
    // A foreign-org memory the caller can read is the other reason, and says nothing more.
    const otherOrg = await db.organization.create({ data: { name: 'Far', urn: 'far.test' } });
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: otherOrg.id, role: 'ADMIN' } });
    const far = await db.memory.create({ data: { name: 'Far', urn: 'far.test:flow', class: 'knowledge', organizationId: otherOrg.id } });
    await db.node.create({ data: { memoryId: far.id, loc: 'entry', name: 'f', isRunnable: true, content: 'f' } });
    const readableForeign = await preview({}, { input: { ...f.input, entryNodeUrn: 'hrn:node:far.test:flow:entry' } }, f.ctx);
    expect(readableForeign).toMatchObject({ outcome: 'CANNOT_BE_ADOPTED', reason: 'OTHER' });
  });
});
