/** #2438: a stored automation keys its entry by NODE ID, not by literal URN.
 * A same-memory rename/move of the entry keeps the adoption valid (Vera's
 * ruling on cor:agt:010:01: within one memory the program's content and its
 * trust set are unchanged); a move to ANOTHER memory changes the trust set
 * and still fails AUTOMATION_CHANGED until re-adopted. Legacy v3 pins keep
 * verifying under their literal-URN identity — never a silent unadopt. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { nodeMutations } from '../api/graphql/schema/resolvers.mutation.node.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { captureAutomationPin, storedAutomationPin } from '../lib/automation/pins.js';
import { makeProdRunDeps } from './appRunDeps.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

async function fixture() {
  const user = await db.user.create({ data: { handle: 'move-owner' } });
  const org = await db.organization.create({ data: { name: 'Move', urn: 'pin.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Move', urn: 'pin.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'pin.test:flow', class: 'knowledge', organizationId: org.id } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const next = await db.node.create({ data: { memoryId: memory.id, loc: 'next', name: 'Next', isRunnable: true, content: 'approved next' } });
  await db.edge.create({ data: { memoryId: memory.id, sourceId: entry.id, targetId: next.id, name: 'next', loc: 'entry:next:next' } });
  const ctx = { db, userId: user.id, roles: [] };
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Mover', cron: '* * * * *', entryNodeUrn: 'hrn:node:pin.test:flow:entry', runAsSelf: true } }, ctx);
  const run = () => mintAppRun(db, { appId: app.id, organizationId: org.id, userId: user.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' }));
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: {} }) as never), llm, writeOutput: vi.fn(async () => null) };
  return { user, org, app, memory, entry, next, ctx, schedule, run, deps, llm };
}

async function adopt(f: Awaited<ReturnType<typeof fixture>>) {
  const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.schedule.id };
  const pin = await automationPinQueries.previewAutomation({}, input, f.ctx);
  await automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, f.ctx);
  return storedAutomationPin(pin);
}

const renameEntry = (f: Awaited<ReturnType<typeof fixture>>) =>
  nodeMutations.moveNode({}, { sourceRef: f.entry.id, targetUrn: 'hrn:node:pin.test:flow:renamed-entry' }, f.ctx);

describe('#2438 entry keyed by node id', () => {
  it('keeps executing after a same-memory rename of the adopted entry', async () => {
    const f = await fixture();
    await adopt(f);
    await renameEntry(f);
    const run = await f.run();
    expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
    expect(f.llm).toHaveBeenCalledTimes(2);
  });

  it('still fails AUTOMATION_CHANGED after the entry moves to another memory', async () => {
    const f = await fixture();
    await adopt(f);
    const elsewhere = await db.memory.create({ data: { name: 'Elsewhere', urn: 'pin.test:elsewhere', class: 'knowledge', organizationId: f.org.id } });
    await nodeMutations.moveNode({}, { sourceRef: f.entry.id, targetUrn: `hrn:node:${elsewhere.urn}:entry` }, f.ctx);
    const run = await f.run();
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED', message: expect.stringMatching(/re-adopt/) });
  });

  it('approval state stays ADOPTED across a same-memory rename', async () => {
    const f = await fixture();
    await adopt(f);
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.schedule.id };
    expect((await automationPinQueries.automationApproval({}, input, f.ctx)).state).toBe('ADOPTED');
    await renameEntry(f);
    expect((await automationPinQueries.automationApproval({}, input, f.ctx)).state).toBe('ADOPTED');
  });

  it('adoption and mint key the entry by its node id', async () => {
    const f = await fixture();
    await adopt(f);
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: f.schedule.id } })).entryNodeId).toBe(f.entry.id);
    const run = await f.run();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).entryNodeId).toBe(f.entry.id);
  });

  it('a stored v3 pin keeps verifying under v3 semantics — never a silent unadopt', async () => {
    const f = await fixture();
    // A legacy adoption, as pre-#2438 code stored it. No code path writes v3
    // anymore, so writing the crafted pin to the consent column is the
    // honest simulation of a trigger that predates the format change.
    const v3 = storedAutomationPin(await captureAutomationPin(db, f.app.id, f.user.id,
      'hrn:node:pin.test:flow:entry', f.org.id, f.ctx, {}, { format: 'hadron-automation-pin-v3' }));
    expect(v3.format).toBe('hadron-automation-pin-v3');
    await db.agentSchedule.update({ where: { id: f.schedule.id }, data: { automationPin: v3 as never } });
    const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.schedule.id };
    expect((await automationPinQueries.automationApproval({}, input, f.ctx)).state).toBe('ADOPTED');
    expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
    // v3 keys the entry by its literal URN, so the same rename v4 shrugs at
    // is a loud change under the frozen v3 contract — not a silent unadopt,
    // and not silently relaxed to v4 semantics either.
    await renameEntry(f);
    expect((await automationPinQueries.automationApproval({}, input, f.ctx)).state).toBe('CHANGED');
    const run = await f.run();
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
  });
});
