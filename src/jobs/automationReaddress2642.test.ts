/**
 * #2642: re-addressing an adopted automation's entry node. Schedule AND webhook
 * pins for the cases that are already correct (same-memory rename, subtree move,
 * memory rename keep the adoption; a cross-memory move fails AUTOMATION_CHANGED
 * before any effect; an unreadable target is MEMORY_UNREADABLE), plus the one
 * behavior this slice adds: a CHANGED run's plain `failureReason` names the
 * automation, but only to a caller who may list triggers, and falls back to the
 * identical generic wording for everyone else. Not covered: races, cross-org,
 * merge/copy, encrypted memories, the webhook HTTP route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { nodeMutations } from '../api/graphql/schema/resolvers.mutation.node.js';
import { memoryMutations } from '../api/graphql/schema/resolvers.mutation.memory.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { schedulerTick } from './scheduler.js';
import { makeProdRunDeps } from './appRunDeps.js';
import { plainAutomationLabel, plainRunFailure } from '../lib/automation/plainReason.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

type Kind = 'SCHEDULE' | 'WEBHOOK';
// a webhook name must be lowercase-dash; a schedule's is free text
const nameOf = (kind: Kind) => (kind === 'SCHEDULE' ? 'Weekly report' : 'weekly-report');
const GENERIC = 'the run stopped because this automation was edited or moved after it was approved.';

async function fixture(kind: Kind, name = nameOf(kind)) {
  const user = await db.user.create({ data: { handle: 'rd-owner' } });
  const writer = await db.user.create({ data: { handle: 'rd-writer' } });
  const org = await db.organization.create({ data: { name: 'Rd', urn: 'rd.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { userId: writer.id, organizationId: org.id, role: 'CONTRIBUTOR' } });
  const app = await db.app.create({ data: { name: 'Rd', urn: 'rd.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'rd.test:flow', class: 'knowledge', organizationId: org.id } });
  const elsewhere = await db.memory.create({ data: { name: 'Else', urn: 'rd.test:else', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'grp', name: 'Group', content: 'g' } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'grp:entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const ctx = { db, userId: user.id, roles: [] as never[] };
  const writerCtx = { db, userId: writer.id, roles: [] as never[] };
  const entryNodeUrn = 'hrn:node:rd.test:flow:grp:entry';
  const trigger: { id: string } = kind === 'SCHEDULE'
    ? await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name, cron: '* * * * *', entryNodeUrn, runAsSelf: true } }, ctx as never)
    : (await appRunMutations.createAgentWebhook({}, { input: { appRef: app.id, name, entryNodeUrn, runAsSelf: true } }, ctx as never)).webhook;
  const input = { triggerKind: kind, triggerRef: trigger.id };
  const pin = await automationPinQueries.previewAutomation({}, input, ctx as never);
  await automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, ctx as never);
  const launch = async () => {
    if (kind === 'SCHEDULE') {
      await db.agentSchedule.update({ where: { id: trigger.id }, data: { nextRunAt: new Date(Date.now() - 60_000), enabled: true } });
      await schedulerTick(db, new Date());
      return db.appRun.findFirstOrThrow({ where: { triggerId: trigger.id }, orderBy: { createdAt: 'desc' } });
    }
    const w = await db.agentWebhook.findUniqueOrThrow({ where: { id: trigger.id } });
    return mintAppRun(db, { organizationId: w.organizationId, appId: w.appId, agentId: w.agentId, userId: w.userId, triggerKind: 'WEBHOOK', triggerId: w.id, entryNodeUrn: w.entryNodeUrn, entryNodeId: w.entryNodeId } as never);
  };
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' }));
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: {} }) as never), llm, writeOutput: vi.fn(async () => null) };
  const run = async () => {
    const minted = await launch();
    const outcome = await executeAppRun(db, minted.id, deps);
    const row = await db.appRun.findUniqueOrThrow({ where: { id: minted.id } });
    return { outcome, row, failure: row.failure as { code?: string; reason?: string; message?: string } | null };
  };
  return { user, writer, org, app, memory, elsewhere, entry, ctx, writerCtx, trigger, run, llm };
}
type F = Awaited<ReturnType<typeof fixture>>;
const failureReason = (row: unknown, ctx: unknown) =>
  (resolvers as never as { AppRun: { failureReason: (r: unknown, a: unknown, c: unknown) => Promise<{ kind: string; summary: string; whoCanFix: string; nextStep: string } | null> } })
    .AppRun.failureReason(row, {}, ctx);
const moveEntry = (f: F, to: string) => nodeMutations.moveNode({}, { sourceRef: f.entry.id, targetUrn: to }, f.ctx as never);
const changedRun = async (f: F) => { await moveEntry(f, 'hrn:node:rd.test:else:grp:entry'); const r = await f.run(); expect(r.failure?.code).toBe('AUTOMATION_CHANGED'); return r; };

for (const kind of ['SCHEDULE', 'WEBHOOK'] as Kind[]) describe(`#2642 ${kind}`, () => {
  const NAME = nameOf(kind);
  it('control: an unmoved adopted automation completes', async () => {
    const f = await fixture(kind);
    expect((await f.run()).outcome).toBe('completed');
  });
  it('a same-memory rename of the entry keeps the adoption (entry resolved by id)', async () => {
    const f = await fixture(kind);
    await moveEntry(f, 'hrn:node:rd.test:flow:grp:renamed');
    const r = await f.run();
    expect(r.outcome).toBe('completed');
    expect(f.llm).toHaveBeenCalled();
  });
  it('moving an ancestor (subtree move) keeps the adoption', async () => {
    const f = await fixture(kind);
    const grp = await db.node.findFirstOrThrow({ where: { memoryId: f.memory.id, loc: 'grp' } });
    await nodeMutations.moveNode({}, { sourceRef: grp.id, targetUrn: 'hrn:node:rd.test:flow:grp2' }, f.ctx as never);
    expect((await db.node.findUniqueOrThrow({ where: { id: f.entry.id } })).loc).toBe('grp2:entry');
    expect((await f.run()).outcome).toBe('completed');
  });
  it('renaming the memory keeps the adoption', async () => {
    const f = await fixture(kind);
    await (memoryMutations as never as { updateMemory: (...a: unknown[]) => Promise<unknown> }).updateMemory({}, { id: f.memory.id, urn: 'rd.test:flow2' }, f.ctx);
    expect((await db.memory.findUniqueOrThrow({ where: { id: f.memory.id } })).urn).not.toBe('rd.test:flow');
    expect((await f.run()).outcome).toBe('completed');
  });
  it('a cross-memory move fails AUTOMATION_CHANGED before any effect', async () => {
    const f = await fixture(kind);
    const r = await changedRun(f);
    expect(r.outcome).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
    expect(r.row.tokensSpent).toBe(0);
  });
  it('an unreadable target is MEMORY_UNREADABLE, not CHANGED, even after a cross-memory move', async () => {
    const f = await fixture(kind);
    await moveEntry(f, 'hrn:node:rd.test:else:grp:entry');
    await db.orgMember.deleteMany({ where: { userId: f.user.id, organizationId: f.org.id } });
    const r = await f.run();
    expect(r.failure?.reason).toBe('MEMORY_UNREADABLE');
    expect((await failureReason(r.row, f.ctx))!.kind).toBe('MEMORY_UNREADABLE');
    expect(f.llm).not.toHaveBeenCalled();
  });
  it('a deleted entry answers MEMORY_UNREADABLE like an unreadable one', async () => {
    const f = await fixture(kind);
    await db.node.update({ where: { id: f.entry.id }, data: { deletedAt: new Date() } });
    expect((await f.run()).failure?.reason).toBe('MEMORY_UNREADABLE');
  });

  describe('the plain reason names the automation only for a caller who may list triggers', () => {
    it('names it for the App admin, via the GraphQL field, and leaves the stored failure untouched', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      const before = JSON.stringify(r.row.failure);
      const reason = (await failureReason(r.row, f.ctx))!;
      expect(reason.kind).toBe('CHANGED');
      expect(reason.summary).toContain(`“${NAME}”`);
      expect(reason.summary).toMatch(/edited or moved/);
      expect(reason.nextStep).toMatch(/adopt it again/);
      expect(JSON.stringify(reason)).not.toMatch(/[0-9a-f]{16,}|hrn:|hadron_|AUTOMATION_/);
      expect(JSON.stringify((await db.appRun.findUniqueOrThrow({ where: { id: r.row.id } })).failure)).toBe(before);
    });
    it('a run-readable caller who cannot list triggers gets the generic wording, same shape', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      const named = (await failureReason(r.row, f.ctx))!;
      const generic = (await failureReason(r.row, f.writerCtx))!;
      expect(Object.keys(generic)).toEqual(Object.keys(named));
      expect(generic.summary.toLowerCase()).toContain(GENERIC);
      expect(JSON.stringify(generic)).not.toContain(NAME);
      expect({ ...generic, summary: '' }).toEqual({ ...named, summary: '' });
    });
    it('a caller with no identity gets the generic wording', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      expect(JSON.stringify(await failureReason(r.row, { db, userId: null, roles: [] }))).not.toContain(NAME);
    });
    it('revoked authority falls back to the generic wording', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      await db.orgMember.deleteMany({ where: { userId: f.user.id, organizationId: f.org.id } });
      expect((await failureReason(r.row, f.ctx))!.summary.toLowerCase()).toContain(GENERIC);
    });
    it('a deleted trigger falls back to the generic wording', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      const data = { deletedAt: new Date() };
      if (kind === 'SCHEDULE') await db.agentSchedule.update({ where: { id: f.trigger.id }, data });
      else await db.agentWebhook.update({ where: { id: f.trigger.id }, data });
      expect((await failureReason(r.row, f.ctx))!.summary.toLowerCase()).toContain(GENERIC);
    });
    it('a trigger id belonging to another App is never named (lookup pinned to the run’s App)', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      const other = await db.app.create({ data: { name: 'Other', urn: 'rd.test:other', organizationId: f.org.id } });
      const foreign = { ...r.row, appId: other.id };
      expect((await failureReason(foreign, f.ctx))!.summary.toLowerCase()).toContain(GENERIC);
    });
    it('a lookup that throws does not fail the run read', async () => {
      const f = await fixture(kind);
      const r = await changedRun(f);
      const broken = { db: new Proxy(db, { get: (t, p) => (p === 'agentSchedule' || p === 'agentWebhook' ? { findFirst: () => { throw new Error('boom'); } } : (t as never)[p as never]) }), userId: f.user.id, roles: [] };
      expect((await failureReason(r.row, broken))!.summary.toLowerCase()).toContain(GENERIC);
    });
  });
});

describe('#2642 plain wording', () => {
  it('other trigger kinds and other failure kinds never carry a name', async () => {
    const f = await fixture('SCHEDULE');
    const r = await changedRun(f);
    expect((await failureReason({ ...r.row, triggerKind: 'MANUAL' }, f.ctx))!.summary.toLowerCase()).toContain(GENERIC);
    const unreadable = plainRunFailure({ status: 'FAILED', failure: { code: 'AUTOMATION_CHANGED', reason: 'MEMORY_UNREADABLE' } }, { automationLabel: 'Weekly report' })!;
    expect(unreadable.kind).toBe('MEMORY_UNREADABLE');
    expect(unreadable.summary).not.toContain('Weekly report');
    expect(plainRunFailure({ status: 'FAILED', failure: { code: 'AUTOMATION_UNADOPTED' } }, { automationLabel: 'Weekly report' })!.summary).not.toContain('Weekly report');
  });
  it('a name is one bounded line of plain text', () => {
    expect(plainAutomationLabel('a\n<b>x</b>\u0000 "q"')).toBe('a b x /b q');
    expect(plainAutomationLabel('x'.repeat(200))!.length).toBe(80);
    expect(plainAutomationLabel('   ')).toBeNull();
    expect(plainAutomationLabel(undefined)).toBeNull();
    const t = plainRunFailure({ status: 'FAILED', failure: { code: 'AUTOMATION_CHANGED' } }, { automationLabel: 'A\n<script>' })!;
    expect(t.summary).not.toMatch(/[<>\n]/);
  });
  it('without a label the summary says this automation', () => {
    expect(plainRunFailure({ status: 'FAILED', failure: { code: 'AUTOMATION_CHANGED' } })!.summary).toMatch(/this automation was edited or moved/);
  });
});
