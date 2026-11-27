/**
 * hadron-server#5020 (Billing A13), guard pins (green on main, kept): a run hop records the organization that owns the App
 * the run is in, and the user the run was done for beside it; an Agent another organization owns never changes who is billed
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:05, S1 and S3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

async function fixture(agentOwnedByOtherOrg: boolean) {
  const user = await db.user.create({ data: { handle: 'bill-member' } });
  const org = await db.organization.create({ data: { name: 'BillA', urn: 'billa.test' } });
  const other = await db.organization.create({ data: { name: 'BillB', urn: 'billb.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'BillA', urn: 'billa.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { name: 'Bill agent', urn: 'billa.test:agent', organizationId: agentOwnedByOtherOrg ? other.id : org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'billa.test:flow', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  await db.aiModelPrice.create({ data: { id: generateId(), provider: 'test', model: 'test', tier: 1, inputMicroCentsPerMTok: 300_000_000n, outputMicroCentsPerMTok: 1_500_000_000n, effectiveAt: new Date('2020-01-01') } as never });
  const ctx = { db, userId: user.id, roles: [] };
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Bill', cron: '* * * * *', entryNodeUrn: 'hrn:node:billa.test:flow:entry', runAsSelf: true } }, ctx);
  const run = await mintAppRun(db, { appId: app.id, owner: { organizationId: org.id }, agentId: agent.id, userId: user.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'test' }));
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: { provider: 'test', model: 'test' }, ownerType: 'HADRON_SERVER' }) as never), llm, writeOutput: vi.fn(async () => null) };
  return { user, org, other, app, run, deps };
}

describe('#5020 pin 12: the run hop bills the App\'s owner', () => {
  it('a run in an organization\'s App done for a member records that organization and the member as userId', async () => {
    const f = await fixture(false);
    await executeAppRun(db, f.run.id, f.deps);
    const events = await db.usageEvent.findMany({ where: { appId: f.app.id, type: 'app-run' } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ organizationId: f.org.id, billableUserId: null, userId: f.user.id });
  });

  it('a run whose Agent another organization owns bills the App\'s organization (spec S3)', async () => {
    const f = await fixture(true);
    await executeAppRun(db, f.run.id, f.deps);
    const events = await db.usageEvent.findMany({ where: { appId: f.app.id, type: 'app-run' } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ organizationId: f.org.id, billableUserId: null });
    expect(events.some((e) => e.organizationId === f.other.id)).toBe(false);
  });
});
