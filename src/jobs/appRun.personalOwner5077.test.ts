/**
 * hadron-server#5077 (Billing F3a, first PR F3a-1): a run of an App a person owns carries ONE owner value, never a nullable
 * organization id (finding hrn:node:hadronmemory.com:hadron-server:findings:org-xor-owner-null-comparison-bypass).
 *
 * F3a-1 builds no door: these pins reach a person's run through `mintAppRun` with `PERSONAL_APP_RUNS_ENABLED=true`. The
 * manual door, the owner's read and cancel arms, the SDL and MCP are F3a-2. Each pin names the acceptance item of the issue
 * it covers. Red on main: the `owner` argument, the owner columns on `app_runs` and every `isOwnedBy` site do not exist
 * there; a person's App passes main's `null !== null` comparisons and its `where: { organizationId: null }` filters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../integrations/objectstore/index.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { mintAppRun, executeAppRun, consumeActionTicket, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps, runContext } from './appRunDeps.js';
import { loadFlowNode, resolveFlowMemory } from '../lib/runner/loadFlowNode.js';
import { runReadsNode } from '../lib/runner/runAuthoring.js';
import { resolveRunAiConfig } from '../lib/runner/runAiConfig.js';
import { captureAutomationPin } from '../lib/automation/pins.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { foreignIncludeReader } from '../lib/includes/foreignIncludeReader.js';
import { prepareSecretUse } from '../lib/secrets/readClientReveal.js';
import { admitAndExecuteTool } from '../lib/runner/toolAdmission.js';
import { hadronReadNode, hadronCreateNode, hadronUpdateNode } from '../lib/runner/tools/nodeTools.js';
import { hadronStoreFile } from '../lib/runner/tools/storeTools.js';
import { hadronFindNodes } from '../lib/runner/tools/memorySearchTools.js';
import { hadronRecordContentValidation } from '../lib/runner/tools/contentValidationTools.js';
import { hadronSendSms } from '../lib/runner/tools/smsTools.js';
import { hadronSendEmail } from '../lib/runner/tools/emailTools.js';
import { webPollStart, webPollCancel, webPollList } from '../lib/runner/tools/webPollTools.js';
import { githubIssueSnapshot } from '../lib/runner/tools/githubTools.js';
import { hadronTeamSnapshot } from '../lib/runner/tools/teamSnapshotTools.js';
import { billableAccountOfRun } from '../lib/metering/billableAccount.js';
import { hasAppRelationship } from '../lib/auth/appRelationship.js';
import { composeAppRunUrn } from '../lib/entityRef/appRunRef.js';
import { mergeUsers } from '../test/mergeConsent.js';
import { deleteUserAccount } from '../controller/operations/deleteUser.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import type { AuthContext } from '../middleware/auth.js';
import type { AppRun, PrismaClient } from '../generated/prisma/index.js';
import type { RunToolContext, RunToolDef } from '../lib/runner/tools/types.js';

const ON = 'PERSONAL_APP_RUNS_ENABLED';
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env[ON];
  process.env[ON] = 'true';
  vi.clearAllMocks();
  await cleanDb(db);
});
afterEach(() => {
  if (saved === undefined) delete process.env[ON]; else process.env[ON] = saved;
});

type Person = { user: { id: string }; app: { id: string }; agent: { id: string }; memory: { id: string; urn: string }; entryUrn: string };

/** A person with their own App, Agent and the App's own memory (class app, owned by them), and an entry node in it. */
async function person(handle: string, opts: { memberRow?: boolean } = {}): Promise<Person> {
  const user = await db.user.create({ data: { handle } });
  const app = await db.app.create({ data: { name: `${handle} app`, urn: `${handle}:app`, ownerUserId: user.id } });
  if (opts.memberRow) await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { name: `${handle} agent`, urn: `${handle}:agent`, ownerUserId: user.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const memory = await db.memory.create({ data: { name: `${handle} flow`, urn: `${handle}:flow`, class: 'app', appId: app.id, ownerUserId: user.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read-write' } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'Say ok.' } });
  return { user, app, agent, memory, entryUrn: `hrn:node:${handle}:flow:entry` };
}

const mintFor = (p: Person, extra: Partial<Parameters<typeof mintAppRun>[1]> = {}) => mintAppRun(db, {
  owner: { userId: p.user.id }, appId: p.app.id, agentId: p.agent.id, triggerKind: 'MANUAL', entryNodeUrn: p.entryUrn, publish: false, ...extra,
});

/** A person's run, RUNNING, as the run tools see it. */
async function runningRun(p: Person, userId: string | null = null): Promise<AppRun> {
  return db.appRun.create({ data: {
    id: generateId(), ownerUserId: p.user.id, appId: p.app.id, agentId: p.agent.id, userId,
    triggerKind: 'MANUAL', entryNodeUrn: p.entryUrn, status: 'RUNNING', budgetActions: 50,
  } });
}
const toolCtx = (run: AppRun, nodeUrn?: string): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run), ...(nodeUrn ? { nodeUrn } : {}) });
const call = (def: RunToolDef, run: AppRun, args: Record<string, unknown>) => admitAndExecuteTool(def, args, { toolCtx: toolCtx(run) }) as Promise<Record<string, any>>;

/** A client that throws on ANY model or raw access: "refused before any query". */
const noQueryDb = new Proxy({}, { get: (_t, prop) => { throw new Error(`unexpected query: ${String(prop)}`); } }) as unknown as PrismaClient;

describe('#5077 acceptance 1 and 11: launch with the switch on, refusal with it off', () => {
  it('the owner\'s run of their App is PENDING with organizationId null and ownerUserId the owner', async () => {
    const a = await person('pa5077');
    const run = await mintFor(a);
    expect(run).toMatchObject({ status: 'PENDING', organizationId: null, ownerUserId: a.user.id, appId: a.app.id });
  });

  it('runAsSelf by an owner with NO member row passes the relationship check (mint and hasAppRelationship)', async () => {
    const a = await person('pa5077');
    expect(await db.appMember.count({ where: { appId: a.app.id } })).toBe(0);
    expect(await hasAppRelationship(db, a.app.id, a.user.id)).toBe(true);
    await expect(mintFor(a, { userId: a.user.id })).resolves.toMatchObject({ userId: a.user.id, ownerUserId: a.user.id });
  });

  it('the owner arm of hasAppRelationship is the App\'s owner only: another person has none', async () => {
    const a = await person('pa5077');
    const b = await person('pb5077');
    expect(await hasAppRelationship(db, a.app.id, b.user.id)).toBe(false);
    await expect(mintFor(a, { userId: b.user.id })).rejects.toMatchObject({ code: 'RELATIONSHIP_MISSING' });
  });

  it('with the switch off (unset, or any value but the exact `true`), a person as owner is APP_NOT_FOUND and no row is written', async () => {
    const a = await person('pa5077');
    for (const value of [undefined, 'TRUE', '1', ' true']) {
      if (value === undefined) delete process.env[ON]; else process.env[ON] = value;
      await expect(mintFor(a)).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
    }
    expect(await db.appRun.count()).toBe(0);
  });

  it('F3a-2 opens the manual door: with the switch on the owner\'s triggerAppRun on a person\'s App launches', async () => {
    // Was "the manual door is unchanged in F3a-1"; the full door table is pinned in resolvers.appRun.personalDoor5077.test.ts.
    const a = await person('pa5077');
    const run = await resolvers.Mutation.triggerAppRun({}, { input: { appRef: a.app.id, entryNodeUrn: a.entryUrn } } as never,
      { db, userId: a.user.id, roles: [] } as unknown as Context) as { organizationId: string | null; ownerUserId: string | null };
    expect(run).toMatchObject({ organizationId: null, ownerUserId: a.user.id });
  });
});

describe('#5077 decision b: the owner\'s own policy is the first link of a person\'s App', () => {
  it('the owner\'s User.policy that does not allow run.execute refuses the launch POLICY_DENIED, with no row', async () => {
    const a = await person('pa5077');
    await db.user.update({ where: { id: a.user.id }, data: { policy: { allow: ['memory.read'] } } });
    await expect(mintFor(a)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await db.appRun.count()).toBe(0);
  });

  it('and the snapshot on the run holds that link when it allows the run', async () => {
    const a = await person('pa5077');
    await db.user.update({ where: { id: a.user.id }, data: { policy: { allow: ['run.execute', 'llm.invoke'] } } });
    const run = await mintFor(a);
    expect(run.policy).toEqual({ chain: [{ allow: ['run.execute', 'llm.invoke'] }] });
  });
});

describe('#5077 acceptance 3: another person\'s rows at mint', () => {
  it('A\'s App with the entry in B\'s memory is ENTRY_NOT_IN_ORG (owner wording) and writes no row', async () => {
    const a = await person('pa5077');
    const b = await person('pb5077');
    await expect(mintFor(a, { entryNodeUrn: b.entryUrn })).rejects.toMatchObject({
      code: 'ENTRY_NOT_IN_ORG', message: 'The entry node is not in a memory this App\'s owner owns.',
    });
    expect(await db.appRun.count()).toBe(0);
  });

  it('B\'s App named with A as owner is APP_NOT_FOUND; an organization as owner of a person\'s App too', async () => {
    const a = await person('pa5077');
    const b = await person('pb5077');
    const org = await db.organization.create({ data: { name: 'O5077', urn: 'o5077.test' } });
    await expect(mintAppRun(db, { owner: { userId: a.user.id }, appId: b.app.id, agentId: b.agent.id, triggerKind: 'MANUAL', entryNodeUrn: b.entryUrn, publish: false }))
      .rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
    await expect(mintAppRun(db, { owner: { organizationId: org.id }, appId: a.app.id, agentId: a.agent.id, triggerKind: 'MANUAL', entryNodeUrn: a.entryUrn, publish: false }))
      .rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5077 acceptance 4: another person\'s memory at every reader of the run path', () => {
  // One case per reader. A reader added to the run path is added here (and the source guard keeps the nullable id off it).
  const cases: Array<[string, (a: Person, b: Person, run: AppRun) => Promise<unknown>]> = [
    ['resolveFlowMemory', (_a, b) => resolveFlowMemory(db, b.memory.urn, { userId: _a.user.id }, b.entryUrn)],
    ['loadFlowNode', (a, b, run) => loadFlowNode(db, b.entryUrn, { userId: a.user.id }, runContext(db, run))],
    ['runReadsNode', async (_a, b, run) => {
      if (await runReadsNode(db, runContext(db, run), run, b.memory.id, 'entry')) return 'read';
      throw new Error('refused');
    }],
    ['hadron_read_node', async (_a, b, run) => { const out = await call(hadronReadNode, run, { urn: b.entryUrn }); if (out?.error || out?.isError) throw new Error('refused'); return out; }],
    ['hadron_create_node', async (_a, b, run) => { const out = await call(hadronCreateNode, run, { urn: `hrn:node:${b.memory.urn}:fresh`, name: 'fresh' }); if (out?.error || out?.isError) throw new Error('refused'); return out; }],
    ['hadron_update_node', async (_a, b, run) => { const out = await call(hadronUpdateNode, run, { urn: b.entryUrn, content: 'pwned' }); if (out?.error || out?.isError) throw new Error('refused'); return out; }],
    ['hadron_store_file', async (_a, b, run) => { const out = await call(hadronStoreFile, run, { urn: `hrn:node:${b.memory.urn}:file`, filename: 'f.txt', contentType: 'text/plain', content: 'x' }); if (out?.error || out?.isError) throw new Error('refused'); return out; }],
    ['hadron_find_nodes (named memory)', async (_a, b, run) => {
      const out = await call(hadronFindNodes, run, { query: 'Entry', memoryUrn: `hrn:mem:${b.memory.urn}` });
      // The tool answers `hits`; an empty list is the fence's answer for a memory outside the run's owner.
      if (out?.error || out?.isError || !(out.hits?.length > 0)) throw new Error('refused');
      return out;
    }],
    ['writeTo', async (_a, b, run) => {
      await db.node.update({ where: { loc_memoryId: { loc: 'entry', memoryId: (await db.memory.findFirstOrThrow({ where: { ownerUserId: run.ownerUserId! } })).id } }, data: { data: { output: { writeTo: `hrn:node:${b.memory.urn}:out` } } } });
      return makeProdRunDeps(db).writeOutput(run, run.entryNodeUrn, 'text');
    }],
    ['hadron_record_content_validation', async (_a, b, run) => {
      const node = await db.node.findFirstOrThrow({ where: { memoryId: b.memory.id, loc: 'entry' } });
      // Only the memory guard's answer counts as its refusal: past it, the resolver refuses this fixture for another reason
      // (no validation task configured), which the control below shows for A's own node.
      const err = await call(hadronRecordContentValidation, run, { nodeRef: node.id, nodeRevision: 1, validationTaskRef: node.id, validationTaskRevision: 1, outcome: 'PASS' })
        .then(() => null, (e: unknown) => e as Error);
      if (err && /Node not found/.test(err.message)) throw err;
      return err?.message ?? 'recorded';
    }],
    ['an include by URN in the automation pin', async (a, b) => {
      await db.node.update({ where: { loc_memoryId: { loc: 'entry', memoryId: a.memory.id } }, data: { content: `{{> ${b.entryUrn} }}` } });
      // The run's own principal, as setup and the run's re-check capture it (pins.ts), so the shared gate is the run's.
      // The guard's answer is the capture SUCCEEDING with B's include recorded as absent and none of B's nodes pinned. A
      // capture that follows the include and then fails on B's node (AUTOMATION_CHANGED) is a different refusal, so it
      // counts as the guard having admitted B's memory.
      const pin = await captureAutomationPin(db, a.app.id, a.user.id, a.entryUrn, { userId: a.user.id }, runAuthContext({ id: 'setup', appId: a.app.id, userId: a.user.id, organizationId: null }) as never)
        .catch((e: Error) => e);
      if (pin instanceof Error) return `followed, then: ${pin.message}`;
      const bEntry = await db.node.findFirstOrThrow({ where: { memoryId: b.memory.id, loc: 'entry' }, select: { id: true } });
      if (pin.absentPartials.some((p) => p.urn === b.entryUrn) && !(bEntry.id in pin.nodes)) {
        throw new Error('recorded as absent');
      }
      return pin;
    }],
    ['a foreign include in a render', async (_a, b, run) => {
      if (await foreignIncludeReader(db, runContext(db, run))(b.memory.id)) return 'read';
      throw new Error('refused');
    }],
  ];

  // Two ways B's memory is open to A through the shared gate, so the tenant fence is the only thing that refuses: B's
  // memory made PUBLIC knowledge, and B's own App's team space with A a member of that App (#1764, which `canReadMemory`
  // admits for A's run principal; the first fixture alone left the runReadsNode, content-validation, pin, foreign-include
  // and find_nodes guards unexercised, because the shared gate refused there before the fence was reached).
  const fixtures: Array<[string, (a: Person, b: Person) => Promise<unknown>]> = [
    ['B\'s PUBLIC knowledge', (_a, b) => db.memory.update({ where: { id: b.memory.id }, data: { class: 'knowledge', appId: null, visibility: 'PUBLIC' } })],
    ['B\'s team space, A a member of B\'s App', (a, b) => db.appMember.create({ data: { appId: b.app.id, userId: a.user.id, role: 'member' } })],
  ];
  for (const [fixture, open] of fixtures) {
    for (const [reader, attempt] of cases) {
      it(`${reader} refuses A's run against ${fixture}`, async () => {
        const a = await person('pa5077');
        const b = await person('pb5077');
        await open(a, b);
        const run = await runningRun(a, a.user.id);
        await expect(Promise.resolve().then(() => attempt(a, b, run))).rejects.toThrow();
        expect(await db.node.findFirst({ where: { memoryId: b.memory.id, loc: { in: ['fresh', 'file', 'out'] } } })).toBeNull();
        expect((await db.node.findFirstOrThrow({ where: { memoryId: b.memory.id, loc: 'entry' } })).content).toBe('Say ok.');
      });
    }
  }

  it('control: the same readers reach A\'s own memory (the fence is the owner, not a blanket refusal)', async () => {
    const a = await person('pa5077');
    const run = await runningRun(a, a.user.id);
    await expect(resolveFlowMemory(db, a.memory.urn, { userId: a.user.id }, a.entryUrn)).resolves.toMatchObject({ id: a.memory.id });
    await expect(loadFlowNode(db, a.entryUrn, { userId: a.user.id }, runContext(db, run))).resolves.toBeTruthy();
    expect(await runReadsNode(db, runContext(db, run), run, a.memory.id, 'entry')).toBe(true);
    expect(await foreignIncludeReader(db, runContext(db, run))(a.memory.id)).toBe(true);
    expect((await call(hadronFindNodes, run, { query: 'Entry', memoryUrn: `hrn:mem:${a.memory.urn}` })).hits).toHaveLength(1);
    const own = await db.node.findFirstOrThrow({ where: { memoryId: a.memory.id, loc: 'entry' } });
    await expect(call(hadronRecordContentValidation, run, { nodeRef: own.id, nodeRevision: 1, validationTaskRef: own.id, validationTaskRevision: 1, outcome: 'PASS' }))
      .rejects.toThrow(/No validation task is configured/);
  });
});

describe('#5077 acceptance 6: keys (ruled: the App\'s or the Agent\'s own, never the organization\'s or the platform\'s)', () => {
  async function publishedAgentFixture() {
    const a = await person('pa5077');
    const org = await db.organization.create({ data: { name: 'Publisher', urn: 'pub5077.test' } });
    const published = await db.agent.create({ data: { name: 'Published', urn: 'pub5077.test:agent', organizationId: org.id, visibility: 'PUBLIC' } });
    await db.appAgent.create({ data: { appId: a.app.id, agentId: published.id } });
    // A person's App is licensed for an organization's Agent by the owner's own subscription.
    await db.agentSubscription.create({ data: { userId: a.user.id, agentId: published.id, activatedAt: new Date() } });
    await serveAgentBootPrompt(db, published.id, 'Test boot prompt.');
    const server = await db.hadronServer.create({ data: { id: generateId(), url: 'https://s5077.test' } });
    await db.aiServiceConfig.create({ data: { name: 'default', organizationId: org.id, provider: 'test', model: 'org-model' } });
    await db.aiServiceConfig.create({ data: { name: 'default', hadronServerId: server.id, provider: 'test', model: 'platform-model' } });
    return { a, org, published };
  }

  it('with neither an App nor an Agent key: NO_AI_CONFIG, never the publisher organization\'s or the platform\'s', async () => {
    const { a, published } = await publishedAgentFixture();
    await expect(resolveRunAiConfig(db, null, { appId: a.app.id, agentId: published.id, tenant: { userId: a.user.id } }))
      .rejects.toMatchObject({ name: 'NoAiConfigAvailableError' });
  });

  it('a `default` on the Agent answers (AGENT), whoever owns the Agent', async () => {
    const { a, published } = await publishedAgentFixture();
    await db.aiServiceConfig.create({ data: { name: 'default', agentId: published.id, provider: 'test', model: 'agent-model' } });
    await expect(resolveRunAiConfig(db, null, { appId: a.app.id, agentId: published.id, tenant: { userId: a.user.id } }))
      .resolves.toMatchObject({ ownerType: 'AGENT', config: { model: 'agent-model' } });
  });

  it('the wrapper\'s own rule: a person\'s tenant never takes an ORGANIZATION or HADRON_SERVER answer, even if the walk gives one', async () => {
    // An organization's App walked with a person's tenant: the walk answers the organization's key; the wrapper refuses it.
    const org = await db.organization.create({ data: { name: 'Walk', urn: 'walk5077.test' } });
    const orgApp = await db.app.create({ data: { name: 'walk', urn: 'walk5077.test:app', organizationId: org.id } });
    await db.aiServiceConfig.create({ data: { name: 'default', organizationId: org.id, provider: 'test', model: 'org-model' } });
    const u = await db.user.create({ data: { handle: 'walk5077' } });
    await expect(resolveRunAiConfig(db, null, { appId: orgApp.id, tenant: { organizationId: org.id } })).resolves.toMatchObject({ ownerType: 'ORGANIZATION' });
    await expect(resolveRunAiConfig(db, null, { appId: orgApp.id, tenant: { userId: u.id } })).rejects.toMatchObject({ name: 'NoAiConfigAvailableError' });
  });

  it('a run with no usable configuration fails NO_AI_CONFIG with no model call', async () => {
    const { a, published } = await publishedAgentFixture();
    const run = await mintAppRun(db, { owner: { userId: a.user.id }, appId: a.app.id, agentId: published.id, userId: a.user.id, triggerKind: 'MANUAL', entryNodeUrn: a.entryUrn, publish: false });
    const llm = vi.fn();
    const deps: RunExecutionDeps = { ...makeProdRunDeps(db), llm, writeOutput: vi.fn(async () => null) };
    await executeAppRun(db, run.id, deps);
    expect(llm).not.toHaveBeenCalled();
    expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', failure: { code: 'NO_AI_CONFIG' } });
  });

  it('with a key on the App the run completes; its usage event bills the owner (billableUserId), no organization, no ledger entry', async () => {
    const a = await person('pa5077');
    await db.aiServiceConfig.create({ data: { name: 'default', appId: a.app.id, provider: 'test', model: 'test' } });
    const run = await mintFor(a, { userId: a.user.id });
    const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 10, tokensOut: 5, provider: 'test', model: 'test' }));
    const deps: RunExecutionDeps = { ...makeProdRunDeps(db), llm, writeOutput: vi.fn(async () => null) };
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    const events = await db.usageEvent.findMany({ where: { appId: a.app.id, type: 'app-run' } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ billableUserId: a.user.id, organizationId: null });
    expect(await db.creditLedgerEntry.count()).toBe(0);
    expect(billableAccountOfRun(run)).toEqual({ userId: a.user.id });
  });
});

describe('#5077 acceptance 7: quota', () => {
  it('a launch consumes the App\'s and the person\'s run.execute', async () => {
    const a = await person('pa5077');
    await mintFor(a);
    const rows = await db.quotaCounter.findMany({ where: { action: 'run.execute' } });
    expect(rows.find((r) => r.scopeKind === 'app' && r.scopeId === a.app.id)?.used).toBe(1);
    expect(rows.find((r) => r.scopeKind === 'user' && r.scopeId === a.user.id)?.used).toBe(1);
    expect(rows.some((r) => r.scopeKind === 'org')).toBe(false);
  });

  it('with the person\'s limit at 0: QUOTA_EXCEEDED, the App\'s unit given back, no row', async () => {
    const a = await person('pa5077');
    await db.quotaCounter.create({ data: { id: generateId(), scopeKind: 'user', scopeId: a.user.id, action: 'run.execute', window: 'day', used: 0, limit: 0, resetAt: new Date(Date.now() + 86_400_000) } });
    await expect(mintFor(a)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect((await db.quotaCounter.findFirst({ where: { scopeKind: 'app', scopeId: a.app.id, action: 'run.execute' } }))?.used ?? 0).toBe(0);
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5077 acceptance 8: organization-only tools', () => {
  const orgOnly = ['hadron_send_sms', 'hadron_send_email', 'web_poll_start', 'web_poll_cancel', 'web_poll_list', 'github_issue_snapshot', 'mcp__srv__tool', 'ha__home__get_state'];
  for (const tool of orgOnly) {
    it(`a node naming ${tool} fails NODE_LOAD_FAILED with no model call`, async () => {
      const a = await person('pa5077');
      await db.aiServiceConfig.create({ data: { name: 'default', appId: a.app.id, provider: 'test', model: 'test' } });
      await db.node.update({ where: { loc_memoryId: { loc: 'entry', memoryId: a.memory.id } }, data: { data: { tools: [tool] } } });
      const run = await mintFor(a, { userId: a.user.id });
      const llm = vi.fn();
      const deps: RunExecutionDeps = { ...makeProdRunDeps(db), llm, llmWithTools: vi.fn(), writeOutput: vi.fn(async () => null) } as never;
      await executeAppRun(db, run.id, deps);
      expect(llm).not.toHaveBeenCalled();
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe('FAILED');
      expect(after.failure).toMatchObject({ code: 'NODE_LOAD_FAILED', message: expect.stringContaining(`Tool(s) not available to an App a person owns: ${tool}.`) });
    });
  }

  it('a script node naming an organization-only tool fails the same way', async () => {
    const a = await person('pa5077');
    await db.node.update({ where: { loc_memoryId: { loc: 'entry', memoryId: a.memory.id } }, data: { data: { script: { call: { tool: 'hadron_send_sms', args: {} } } } } });
    const run = await mintFor(a, { userId: a.user.id });
    await executeAppRun(db, run.id, { ...makeProdRunDeps(db), writeOutput: vi.fn(async () => null) });
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.failure).toMatchObject({ code: 'NODE_LOAD_FAILED', message: expect.stringContaining('Tool(s) not available to an App a person owns: hadron_send_sms.') });
  });

  const handlers: Array<[RunToolDef, Record<string, unknown>]> = [
    [hadronSendSms, { to: '+15551234567', body: 'hi' }],
    [hadronSendEmail, { to: 'a@example.test', subject: 's', text: 't' }],
    [webPollStart, { url: 'https://example.test', conditions: [] }],
    [webPollCancel, { jobId: 'j' }],
    [webPollList, {}],
    [githubIssueSnapshot, { repository: 'o/r', since: '2026-01-01T00:00:00Z' }],
  ];
  for (const [def, args] of handlers) {
    it(`${def.name}'s handler refuses a person's run by itself, before any query`, async () => {
      const a = await person('pa5077');
      const run = await runningRun(a);
      await expect(def.execute({ log: vi.fn(), db: noQueryDb, run, principal: runContext(db, run), nodeUrn: a.entryUrn } as RunToolContext, args))
        .rejects.toThrow(`Tool(s) not available to an App a person owns: ${def.name}.`);
    });
  }

  it('consumeActionTicket for a person is false with no query (no ticket can exist); __callbackUrl therefore records skipped:no-ticket', async () => {
    expect(await consumeActionTicket(noQueryDb, { userId: 'u' }, 'app', 'comm.outbound', 'run')).toBe(false);
  });

  it('web_request with a secretClientId refuses ACTION_TICKET_REQUIRED before any query', async () => {
    const a = await person('pa5077');
    const run = await runningRun(a);
    await expect(prepareSecretUse({ log: vi.fn(), db: noQueryDb, run, principal: runContext(db, run) } as RunToolContext, 'client', 'https://example.test', {}))
      .rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
  });

  it('pin (Q6): hadron_team_snapshot refuses a person\'s run (runMayReadTeam is unchanged and fails closed)', async () => {
    const a = await person('pa5077');
    const run = await runningRun(a);
    const out = await call(hadronTeamSnapshot, run, { since: '2026-11-01T00:00:00Z' }).catch((e: unknown) => ({ thrown: e }));
    expect(JSON.stringify(out)).not.toContain('"roster":[{');
    expect('thrown' in (out as object) || (out as Record<string, unknown>).error !== undefined || (out as Record<string, unknown>).isError === true).toBe(true);
  });
});

describe('#5077 acceptance 9: lifecycle', () => {
  it('after merging A into B, A\'s runs have ownerUserId B', async () => {
    const a = await person('pa5077');
    const b = await db.user.create({ data: { handle: 'pb5077' } });
    const admin = await db.user.create({ data: { handle: 'adm5077', roles: ['ADMIN'] } });
    const run = await mintFor(a);
    await mergeUsers(db, { sourceUserId: a.user.id, targetUserId: b.id, actorUserId: admin.id });
    expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ ownerUserId: b.id, organizationId: null });
    expect((await db.app.findUniqueOrThrow({ where: { id: a.app.id } })).ownerUserId).toBe(b.id);
  });

  it('after deleting A, no app_runs row names A, and A\'s usage events remain', async () => {
    const a = await person('pa5077');
    await db.aiServiceConfig.create({ data: { name: 'default', appId: a.app.id, provider: 'test', model: 'test' } });
    const run = await mintFor(a, { userId: a.user.id });
    await executeAppRun(db, run.id, { ...makeProdRunDeps(db), llm: vi.fn(async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' })), writeOutput: vi.fn(async () => null) });
    const usage = await db.usageEvent.count({ where: { billableUserId: a.user.id } });
    expect(usage).toBeGreaterThan(0);
    await deleteUserAccount(db, { targetUserId: a.user.id, actorUserId: a.user.id });
    expect(await db.appRun.count({ where: { OR: [{ ownerUserId: a.user.id }, { userId: a.user.id }, { appId: a.app.id }] } })).toBe(0);
    expect(await db.usageEvent.count({ where: { billableUserId: a.user.id } })).toBe(usage);
  });

  it('deleting A removes A\'s run even when its Agent outlives A (an organization\'s published Agent): no cascade covers it', async () => {
    const a = await person('pa5077');
    const org = await db.organization.create({ data: { name: 'Publisher', urn: 'pubdel5077.test' } });
    const published = await db.agent.create({ data: { name: 'Published', urn: 'pubdel5077.test:agent', organizationId: org.id, visibility: 'PUBLIC' } });
    await db.appAgent.create({ data: { appId: a.app.id, agentId: published.id } });
    const run = await db.appRun.create({ data: {
      id: generateId(), ownerUserId: a.user.id, appId: a.app.id, agentId: published.id, userId: null,
      triggerKind: 'MANUAL', entryNodeUrn: a.entryUrn, status: 'COMPLETED', budgetActions: 50,
    } });
    await deleteUserAccount(db, { targetUserId: a.user.id, actorUserId: a.user.id });
    expect(await db.agent.findUnique({ where: { id: published.id } })).not.toBeNull();
    expect(await db.appRun.findUnique({ where: { id: run.id } })).toBeNull();
  });
});

describe('#5077 acceptance 10: the database', () => {
  it('chk_app_run_owner_xor refuses a row with both owner columns and a row with neither', async () => {
    const a = await person('pa5077');
    const org = await db.organization.create({ data: { name: 'X', urn: 'x5077.test' } });
    const base = { appId: a.app.id, agentId: a.agent.id, triggerKind: 'MANUAL' as const, entryNodeUrn: a.entryUrn };
    await expect(db.appRun.create({ data: { id: generateId(), ...base, organizationId: org.id, ownerUserId: a.user.id } })).rejects.toThrow(/chk_app_run_owner_xor/);
    await expect(db.appRun.create({ data: { id: generateId(), ...base } })).rejects.toThrow(/chk_app_run_owner_xor/);
  });
});

describe('#5077 F3a-2 (replaces the F3a-1 interim): reads and cancel of a person\'s run', () => {
  it('a platform admin reads nothing: appRun(ref:) null, latestAppRun not found, resolveUrn null', async () => {
    const a = await person('pa5077');
    const run = await mintFor(a);
    const admin = { db, userId: (await db.user.create({ data: { handle: 'adm5077' } })).id, roles: ['ADMIN'] } as unknown as Context;
    expect(await resolvers.Query.appRun({}, { ref: run.id }, admin)).toBeNull();
    await expect(resolvers.Query.latestAppRun({}, { appRef: a.app.id }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    // Rook SEC10 P3-1 on #5420: without resolveUrn's null-organization branch, isOrgMember admits a platform admin.
    expect(await resolvers.Query.resolveUrn({}, { urn: composeAppRunUrn('pa5077:app', run.id) }, admin)).toBeNull();
  });

  it('the owner reads every run of their App (on their behalf, one they started, latest), the App key its run, MCP too', async () => {
    // Byron SECOND P2-1 / Belinda BLIND P2-1 on #5420 asked for the null-organization branch first; F3a-2 keeps it first and
    // gives it the ruled arms (cor:dmo:050:12).
    const a = await person('pa5077');
    const owner = { db, userId: a.user.id, roles: [] } as unknown as Context;
    const onBehalf = await mintFor(a, { userId: a.user.id });
    const started = await mintFor(a, { createdBy: a.user.id });
    expect(await resolvers.Query.appRun({}, { ref: onBehalf.id }, owner)).toMatchObject({ id: onBehalf.id });
    expect(await resolvers.Query.appRun({}, { ref: started.id }, owner)).toMatchObject({ id: started.id });
    expect(await resolvers.Query.latestAppRun({}, { appRef: a.app.id }, owner)).toMatchObject({ id: started.id });
    const appKey = { db, appId: a.app.id, roles: [] } as unknown as Context;
    expect(await resolvers.Query.appRun({}, { ref: started.id }, appKey)).toMatchObject({ id: started.id });
    const text = await createTestableMcpServer({ userId: a.user.id, roles: ['READER'], clientId: `user:${a.user.id}` } as AuthContext)
      .callToolText('hadron_get_run', { ref: onBehalf.id });
    expect(text).toContain(onBehalf.id);
  });

  it('the owner cancels a person\'s run', async () => {
    const a = await person('pa5077');
    const run = await mintFor(a, { userId: a.user.id });
    await expect(resolvers.Mutation.cancelAppRun({}, { ref: run.id }, { db, userId: a.user.id, roles: [] } as unknown as Context))
      .resolves.toMatchObject({ id: run.id, status: 'CANCELLED' });
  });
});

describe('#5077 acceptance 12: an organization\'s App is unchanged', () => {
  it('an organization\'s run states its organization and no person, and bills the organization', async () => {
    const org = await db.organization.create({ data: { name: 'Org', urn: 'org5077.test' } });
    const app = await db.app.create({ data: { name: 'oa', urn: 'org5077.test:app', organizationId: org.id } });
    const agent = await db.agent.create({ data: { name: 'oa', urn: 'org5077.test:agent', organizationId: org.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
    const memory = await db.memory.create({ data: { name: 'f', urn: 'org5077.test:flow', class: 'knowledge', organizationId: org.id } });
    await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'ok' } });
    delete process.env[ON];
    const run = await mintAppRun(db, { owner: { organizationId: org.id }, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:org5077.test:flow:entry', publish: false });
    expect(run).toMatchObject({ organizationId: org.id, ownerUserId: null });
    expect(billableAccountOfRun(run)).toEqual({ organizationId: org.id });
    expect((await db.quotaCounter.findFirst({ where: { scopeKind: 'org', scopeId: org.id, action: 'run.execute' } }))?.used).toBe(1);
  });
});
