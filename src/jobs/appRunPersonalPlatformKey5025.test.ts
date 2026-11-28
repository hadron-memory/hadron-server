/**
 * hadron-server#5025 (Billing A8): the platform's own AI provider key for a person with no organization, open ONLY while
 * charging and the credit gate are both on (`creditGateActive()`, src/lib/metering/gate.ts), so every such use is debited
 * to the person and gated on the person's balance (cor:dmo:050:10 as amended, cor:dmo:170:05, cor:acl:050:05).
 *
 * Red on main: F2's `platformLevelOpen` (src/lib/aiConfig.ts) closes the platform level to a person's tenant and F3a's
 * `resolveRunAiConfig` refuses a `HADRON_SERVER` answer for a person's run, so a person's App with only the platform's
 * `default` fails NO_AI_CONFIG whatever the switches say.
 *
 * Named `appRun…` like its neighbours (`appRunCreditGate5023`, `appRunBillable5020`, `appRun.personalOwner5077`), which
 * all test `appRuns.ts`; the singular is this directory's convention, not a mismatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../integrations/objectstore/index.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

import { db } from '../integrations/db/client.js';
import { cleanDb, createPriceRowForTest } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { resolveAiConfig } from '../lib/aiConfig.js';
import { assertRunAiConfigStillOpen, requestedAiConfigName, resolveRunAiConfig } from '../lib/runner/runAiConfig.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { clearPriceCache, creditBalance, grantCredits, recordLlmUsage } from '../lib/metering/index.js';
import { reloadOwnerDefaultMonthlyGrantForTests, resetPeriodGrantStateForTests } from '../lib/metering/periodGrant.js';
import { CREDITS_EXHAUSTED_MESSAGE, resetCreditGateMemoForTests } from '../lib/metering/gate.js';
import { mintAppRun, executeAppRun, RunLaunchDeniedError, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';
import { AutomationPinError } from '../lib/automation/pins.js';

const RUNS = 'PERSONAL_APP_RUNS_ENABLED';
const DEBIT = 'BILLING_DEBIT_ENABLED';
const GATE = 'BILLING_CREDIT_GATE_ENABLED';

beforeEach(async () => {
  vi.stubEnv(RUNS, 'true');
  vi.clearAllMocks();
  await cleanDb(db);
  clearPriceCache();
  resetPeriodGrantStateForTests();
  resetCreditGateMemoForTests();
  reloadOwnerDefaultMonthlyGrantForTests({});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const switchesOn = () => { vi.stubEnv(DEBIT, 'true'); vi.stubEnv(GATE, 'true'); };

/** The switch settings that must keep the platform level closed for a person: every one but both exactly on. */
const CLOSED_SETTINGS: Array<[string, Record<string, string | undefined>]> = [
  ['both unset', { [DEBIT]: undefined, [GATE]: undefined }],
  ['debit off, gate on', { [DEBIT]: undefined, [GATE]: 'true' }],
  ['debit on, gate off', { [DEBIT]: 'true', [GATE]: undefined }],
  ['debit on, gate `TRUE` (only the exact `true` counts)', { [DEBIT]: 'true', [GATE]: 'TRUE' }],
  ['debit on, gate `1`', { [DEBIT]: 'true', [GATE]: '1' }],
];
const applySettings = (s: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) vi.stubEnv(k, undefined as unknown as string); else vi.stubEnv(k, v);
  }
};

type Person = { user: { id: string }; app: { id: string }; agent: { id: string }; memoryId: string; entryUrn: string };

/** A person with their own App, their own Agent, the App's own memory and a two-hop flow (entry -> next). */
async function person(handle: string): Promise<Person> {
  const user = await db.user.create({ data: { handle } });
  const app = await db.app.create({ data: { name: `${handle} app`, urn: `${handle}:app`, ownerUserId: user.id } });
  const agent = await db.agent.create({ data: { name: `${handle} agent`, urn: `${handle}:agent`, ownerUserId: user.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const memory = await db.memory.create({ data: { name: `${handle} flow`, urn: `${handle}:flow`, class: 'app', appId: app.id, ownerUserId: user.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read-write' } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'Say ok.' } });
  const next = await db.node.create({ data: { memoryId: memory.id, loc: 'next', name: 'Next', content: 'Say ok again.' } });
  await db.edge.create({ data: { memoryId: memory.id, sourceId: entry.id, targetId: next.id, name: 'next', loc: deriveEdgeLoc('entry', 'next', 'next') } });
  return { user, app, agent, memoryId: memory.id, entryUrn: `hrn:node:${handle}:flow:entry` };
}

/** The platform's own `default` (the HadronServer level) and a price for its model, so a platform-key unit is charged. */
async function platformDefault() {
  const server = await db.hadronServer.create({ data: { id: generateId(), url: 'https://a8-5025.test' } });
  await db.aiServiceConfig.create({ data: { name: 'default', hadronServerId: server.id, provider: 'test', model: 'platform-model' } });
  await createPriceRowForTest(db, { data: {
    id: generateId(), provider: 'test', model: 'platform-model', tier: 1,
    inputMicroCentsPerMTok: 30_000_000_000n, outputMicroCentsPerMTok: 150_000_000_000n, effectiveAt: new Date('2020-01-01'),
  } });
  return server;
}

const mintFor = (p: Person, eventData?: Record<string, unknown>) => mintAppRun(db, {
  owner: { userId: p.user.id }, appId: p.app.id, agentId: p.agent.id, userId: p.user.id,
  triggerKind: 'MANUAL', entryNodeUrn: p.entryUrn, publish: false, ...(eventData ? { eventData } : {}),
});
const fund = (p: Person, amount: bigint) =>
  grantCredits(db, { owner: { userId: p.user.id }, amountMicroCents: amount, sourceType: 'test', sourceId: `fund-${p.user.id}-${amount}` });
const deps = (llm: RunExecutionDeps['llm']): RunExecutionDeps => ({ ...makeProdRunDeps(db), llm, writeOutput: vi.fn(async () => null) });
const ok = () => vi.fn(async () => ({ text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'platform-model' }));

describe('#5025 acceptance 1: both switches on, a person\'s App with only the platform\'s default, a positive balance', () => {
  it('the owner\'s run resolves HADRON_SERVER, completes, and its unit is debited to the person and to no organization', async () => {
    switchesOn();
    const p = await person('a8one');
    await platformDefault();
    const org = await db.organization.create({ data: { name: 'Bystander', urn: 'bystander5025.test' } });
    await fund(p, 1_000_000_000n);
    const before = await creditBalance(db, { userId: p.user.id });

    await expect(resolveRunAiConfig(db, null, { appId: p.app.id, agentId: p.agent.id, tenant: { userId: p.user.id } }))
      .resolves.toMatchObject({ ownerType: 'HADRON_SERVER', config: { model: 'platform-model' } });

    const run = await mintFor(p);
    const llm = ok();
    expect(await executeAppRun(db, run.id, deps(llm))).toBe('completed');
    expect(llm).toHaveBeenCalled();

    const events = await db.usageEvent.findMany({ where: { appId: p.app.id, type: 'app-run' } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ billableUserId: p.user.id, organizationId: null, keyOwnerType: 'HADRON_SERVER' });
    const debits = await db.creditLedgerEntry.findMany({ where: { kind: 'debit' } });
    expect(debits.length).toBeGreaterThan(0);
    for (const d of debits) expect(d).toMatchObject({ ownerUserId: p.user.id, organizationId: null });
    expect(await db.creditLedgerEntry.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await creditBalance(db, { userId: p.user.id })).toBeLessThan(before);
  });
});

describe('#5025 acceptance 2: both switches on, a zero balance', () => {
  it('the launch is refused CREDITS_EXHAUSTED and no run row is written', async () => {
    switchesOn();
    const p = await person('a8zero');
    await platformDefault();
    const err = await mintFor(p).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RunLaunchDeniedError);
    expect((err as RunLaunchDeniedError).code).toBe('CREDITS_EXHAUSTED');
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5025 acceptance 3: any other switch setting keeps the platform closed to a person, exactly as before', () => {
  for (const [label, settings] of CLOSED_SETTINGS) {
    it(`${label}: the run wrapper refuses (NoAiConfigAvailableError) and a launched run fails NO_AI_CONFIG with no model call`, async () => {
      applySettings(settings);
      const p = await person('a8closed');
      await platformDefault();
      await fund(p, 1_000_000_000n);
      await expect(resolveRunAiConfig(db, null, { appId: p.app.id, agentId: p.agent.id, tenant: { userId: p.user.id } }))
        .rejects.toMatchObject({ name: 'NoAiConfigAvailableError' });
      // The walk itself, for the four personal contexts: closed, as on main.
      const org = await db.organization.create({ data: { name: 'Pub', urn: 'pub5025closed.test' } });
      const orgAgent = await db.agent.create({ data: { name: 'Pub agent', urn: 'pub5025closed.test:agent', organizationId: org.id } });
      for (const ctx of [
        { appId: p.app.id },
        { appId: p.app.id, agentId: p.agent.id },
        { appId: p.app.id, agentId: orgAgent.id },
        { agentId: p.agent.id },
      ]) expect(await resolveAiConfig(db, 'default', ctx)).toBeNull();

      const run = await mintFor(p);
      const llm = ok();
      await executeAppRun(db, run.id, deps(llm));
      expect(llm).not.toHaveBeenCalled();
      expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', failure: { code: 'NO_AI_CONFIG' } });
      expect(await db.creditLedgerEntry.count({ where: { kind: 'debit' } })).toBe(0);
    });
  }
});

describe('#5025 acceptance 4: a person\'s App never takes the publisher organization\'s key (item 4, built as no)', () => {
  for (const on of [true, false]) {
    it(`with the switches ${on ? 'on' : 'off'}: an organization's Agent whose organization has a default never answers ORGANIZATION`, async () => {
      if (on) switchesOn();
      const p = await person('a8pub');
      await platformDefault();
      const org = await db.organization.create({ data: { name: 'Publisher', urn: 'pub5025.test' } });
      const published = await db.agent.create({ data: { name: 'Published', urn: 'pub5025.test:agent', organizationId: org.id, visibility: 'PUBLIC' } });
      await db.appAgent.create({ data: { appId: p.app.id, agentId: published.id } });
      await db.aiServiceConfig.create({ data: { name: 'default', organizationId: org.id, provider: 'test', model: 'org-model' } });
      const walked = await resolveAiConfig(db, 'default', { appId: p.app.id, agentId: published.id });
      expect(walked?.ownerType).not.toBe('ORGANIZATION');
      const run = resolveRunAiConfig(db, null, { appId: p.app.id, agentId: published.id, tenant: { userId: p.user.id } });
      if (on) await expect(run).resolves.toMatchObject({ ownerType: 'HADRON_SERVER' });
      else await expect(run).rejects.toMatchObject({ name: 'NoAiConfigAvailableError' });
    });
  }

  it('the run wrapper refuses an ORGANIZATION answer for a person\'s tenant even with the switches on', async () => {
    switchesOn();
    const org = await db.organization.create({ data: { name: 'Walk', urn: 'walk5025.test' } });
    const orgApp = await db.app.create({ data: { name: 'walk', urn: 'walk5025.test:app', organizationId: org.id } });
    await db.aiServiceConfig.create({ data: { name: 'default', organizationId: org.id, provider: 'test', model: 'org-model' } });
    const u = await db.user.create({ data: { handle: 'walk5025' } });
    await expect(resolveRunAiConfig(db, null, { appId: orgApp.id, tenant: { userId: u.id } })).rejects.toMatchObject({ name: 'NoAiConfigAvailableError' });
  });
});

describe('#5025 acceptance 5: every organization and server context answers the same with the switches on and off', () => {
  async function orgFixture() {
    const server = await platformDefault();
    const org = await db.organization.create({ data: { name: 'Acme', urn: 'acme5025.test' } });
    const other = await db.organization.create({ data: { name: 'Other', urn: 'other5025.test' } });
    const orgApp = await db.app.create({ data: { name: 'acme app', urn: 'acme5025.test:app', organizationId: org.id } });
    const orgAgent = await db.agent.create({ data: { name: 'acme agent', urn: 'acme5025.test:agent', organizationId: org.id } });
    const otherAgent = await db.agent.create({ data: { name: 'other agent', urn: 'other5025.test:agent', organizationId: other.id } });
    const u = await db.user.create({ data: { handle: 'a8orgctx' } });
    const personalAgent = await db.agent.create({ data: { name: 'personal agent', urn: 'a8orgctx:agent', ownerUserId: u.id } });
    // The second organization has its own default: an organization context must keep answering from its own tenant.
    await db.aiServiceConfig.create({ data: { name: 'default', organizationId: other.id, provider: 'test', model: 'other-model' } });
    return { server, org, orgApp, orgAgent, otherAgent, personalAgent };
  }
  const contexts = (f: Awaited<ReturnType<typeof orgFixture>>) => [
    { label: 'an organization\'s App alone', ctx: { appId: f.orgApp.id } },
    { label: 'with its own Agent', ctx: { appId: f.orgApp.id, agentId: f.orgAgent.id } },
    { label: 'with another organization\'s Agent', ctx: { appId: f.orgApp.id, agentId: f.otherAgent.id } },
    { label: 'with a person\'s Agent', ctx: { appId: f.orgApp.id, agentId: f.personalAgent.id } },
    { label: 'an organization\'s Agent alone', ctx: { agentId: f.orgAgent.id } },
    { label: 'the server context', ctx: {} },
    { label: 'an explicit organization (a job scoped to one)', ctx: { organizationId: f.org.id } },
  ];

  it('the run wrapper, given an organization\'s tenant, answers the same level and configuration on and off (Belinda\'s P2-1 on #5479)', async () => {
    const f = await orgFixture();
    const own = await db.app.create({ data: { name: 'other app', urn: 'other5025.test:app', organizationId: (await db.agent.findUniqueOrThrow({ where: { id: f.otherAgent.id } })).organizationId! } });
    const cells = [
      { label: 'platform level (Acme has no default)', ctx: { appId: f.orgApp.id, agentId: f.orgAgent.id, tenant: { organizationId: f.org.id } }, level: 'HADRON_SERVER' },
      { label: 'organization level (Other has its own)', ctx: { appId: own.id, agentId: f.otherAgent.id, tenant: { organizationId: own.organizationId! } }, level: 'ORGANIZATION' },
    ];
    const answer = async () => Promise.all(cells.map(async ({ ctx }) => {
      const r = await resolveRunAiConfig(db, null, ctx);
      return `${r.ownerType}:${r.config.id}`;
    }));
    const off = await answer();
    switchesOn();
    expect(await answer()).toEqual(off);
    cells.forEach((c, i) => expect(off[i], c.label).toMatch(new RegExp(`^${c.level}:`)));
  });

  it('level and configuration id are identical in every cell, switches on versus off', async () => {
    const f = await orgFixture();
    const answer = async () => Promise.all(contexts(f).map(async ({ label, ctx }) => {
      const r = await resolveAiConfig(db, 'default', ctx);
      return [label, r ? `${r.ownerType}:${r.config.id}` : null] as const;
    }));
    const off = await answer();
    switchesOn();
    const on = await answer();
    expect(on).toEqual(off);
    // and the organization contexts do reach the platform level (the opening is not where they get it from)
    expect(off.find(([l]) => l === 'an organization\'s App alone')?.[1]).toMatch(/^HADRON_SERVER:/);
  });
});

describe('#5025 acceptance 2 (mid-run): a person\'s balance reaching zero stops the run at its next model hop', () => {
  it('hop 1 runs and is debited to the person; hop 2 is refused DENIED_CREDITS before its model call', async () => {
    switchesOn();
    const p = await person('a8mid');
    await platformDefault();
    await fund(p, 1n);
    const run = await mintFor(p);
    // hop 1 spends far more than the one micro-cent; drop the gate's 5 s positive memo so hop 2 reads the ledger
    const llm = vi.fn(async () => { resetCreditGateMemoForTests(); return { text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'platform-model' }; });
    expect(await executeAppRun(db, run.id, deps(llm))).toBe('failed');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      failure: { code: 'ACTIVATION_DENIED', reason: 'DENIED_CREDITS', message: CREDITS_EXHAUSTED_MESSAGE },
    });
    expect(await creditBalance(db, { userId: p.user.id })).toBeLessThan(0n);
    expect(await db.creditLedgerEntry.count({ where: { kind: 'debit', ownerUserId: p.user.id } })).toBe(1);
  });
});

describe('#5025 ruling 3 (Holger, 2026-11-28): a switch turned off mid-run fails a person\'s run at its next model hop, NO_AI_CONFIG', () => {
  for (const [label, off] of [['the gate switch', GATE], ['the debit switch', DEBIT]] as const) {
    it(`${label} goes off after hop 1: hop 2 fails NO_AI_CONFIG with no model call, and only hop 1 is debited`, async () => {
      switchesOn();
      const p = await person('a8toggle');
      await platformDefault();
      await fund(p, 1_000_000_000n);
      const run = await mintFor(p);
      let calls = 0;
      const llm = vi.fn(async () => {
        if (++calls === 1) vi.stubEnv(off, 'false');
        return { text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'platform-model' };
      });
      expect(await executeAppRun(db, run.id, deps(llm))).toBe('failed');
      expect(llm).toHaveBeenCalledTimes(1);
      const failure = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure as { code: string; message: string; reason?: string };
      expect(failure.code).toBe('NO_AI_CONFIG');
      expect(failure.reason).toBeUndefined();
      expect(failure.message).toMatch(/^No AI configuration available: .* an App a person owns\)/);
      // hop 1 was charged while the switches were on (a gate-switch toggle leaves debits on, so it is the one debit)
      if (off === GATE) expect(await db.creditLedgerEntry.count({ where: { kind: 'debit', ownerUserId: p.user.id } })).toBe(1);
    });
  }

  it('the hop check stands on its own: with no consent check to notice, hop 2 still fails NO_AI_CONFIG before its model call', async () => {
    switchesOn();
    const p = await person('a8toggle2');
    await platformDefault();
    await fund(p, 1_000_000_000n);
    const run = await mintFor(p);
    let calls = 0;
    const llm = vi.fn(async () => {
      if (++calls === 1) vi.stubEnv(GATE, 'false');
      return { text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'platform-model' };
    });
    const noConsent: RunExecutionDeps = { ...deps(llm), verifyAutomation: vi.fn(async () => {}), checkAutomationEffect: vi.fn(async () => {}) };
    expect(await executeAppRun(db, run.id, noConsent)).toBe('failed');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ failure: { code: 'NO_AI_CONFIG' } });
  });

  for (const [label, flip] of [['a switch went off first', true], ['the switches stayed on (the control)', false]] as const) {
    it(`a pin error inside a hop when ${label}: ${flip ? 'NO_AI_CONFIG wins over AUTOMATION_CHANGED' : 'AUTOMATION_CHANGED as before'}`, async () => {
      switchesOn();
      const p = await person(flip ? 'a8pinoff' : 'a8pinon');
      await platformDefault();
      await fund(p, 1_000_000_000n);
      const run = await mintFor(p);
      // the consent check that notices mid-hop (a tool call's re-check) throws the pin error; the switch flips just before it
      const llm = vi.fn(async () => {
        if (flip) vi.stubEnv(GATE, 'false');
        throw new AutomationPinError('AUTOMATION_CHANGED', 'The automation changed');
      });
      expect(await executeAppRun(db, run.id, deps(llm))).toBe('failed');
      const failure = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure as { code: string };
      expect(failure.code).toBe(flip ? 'NO_AI_CONFIG' : 'AUTOMATION_CHANGED');
    });
  }

  it('the hop refusal names the run\'s requested configuration, read from the run itself (the wiring, not just the helper)', async () => {
    switchesOn();
    const p = await person('a8named');
    await platformDefault();
    await fund(p, 1_000_000_000n);
    // a trigger override with no such configuration: the walk falls back to the platform's `default`
    const run = await mintFor(p, { __aiConfigName: 'custom-5025' });
    let calls = 0;
    const llm = vi.fn(async () => {
      if (++calls === 1) vi.stubEnv(GATE, 'false');
      return { text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'platform-model' };
    });
    expect(await executeAppRun(db, run.id, deps(llm))).toBe('failed');
    const failure = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure as { code: string; message: string };
    expect(failure.code).toBe('NO_AI_CONFIG');
    expect(failure.message).toContain("neither 'custom-5025' nor 'default'");
  });

  it('requestedAiConfigName is the one reader of the override: a string (even empty) counts, anything else is none', () => {
    expect(requestedAiConfigName({ __aiConfigName: 'x' })).toBe('x');
    expect(requestedAiConfigName({ __aiConfigName: '' })).toBe('');
    for (const v of [undefined, null, 7, true, ['x'], { n: 'x' }]) expect(requestedAiConfigName({ __aiConfigName: v })).toBeNull();
    for (const d of [undefined, null, 'x', 7]) expect(requestedAiConfigName(d)).toBeNull();
  });

  it('with the switches staying on, both hops run and both are debited (the control)', async () => {
    switchesOn();
    const p = await person('a8steady');
    await platformDefault();
    await fund(p, 1_000_000_000n);
    const run = await mintFor(p);
    const llm = ok();
    expect(await executeAppRun(db, run.id, deps(llm))).toBe('completed');
    expect(llm).toHaveBeenCalledTimes(2);
    expect(await db.creditLedgerEntry.count({ where: { kind: 'debit', ownerUserId: p.user.id } })).toBe(2);
  });

  it('the per-hop check refuses only a person\'s run on the platform\'s configuration', async () => {
    const platform = { config: { name: 'default' }, ownerType: 'HADRON_SERVER' } as never;
    const own = (ownerType: string) => ({ config: { name: 'default' }, ownerType }) as never;
    // switches off: a person on the platform's configuration is refused; an organization's run never is (it keeps the platform
    // level whatever the switches say), and a person's own-key configuration never is
    expect(() => assertRunAiConfigStillOpen({ userId: 'u' }, 'app', platform, null)).toThrow(/an App a person owns/);
    expect(() => assertRunAiConfigStillOpen({ organizationId: 'o' }, 'app', platform, null)).not.toThrow();
    for (const t of ['APP', 'AGENT']) expect(() => assertRunAiConfigStillOpen({ userId: 'u' }, 'app', own(t), null)).not.toThrow();
    expect(() => assertRunAiConfigStillOpen({ userId: 'u' }, 'app', own('ORGANIZATION'), null)).toThrow(/an App a person owns/);
    // named as the launch-time refusal names it: the REQUESTED name (here 'custom', which fell back to the platform's
    // 'default'), not the resolved configuration's (Belinda's P3 on #5479)
    expect(() => assertRunAiConfigStillOpen({ userId: 'u' }, 'app', platform, 'custom')).toThrow(/neither 'custom' nor 'default'/);
    switchesOn();
    expect(() => assertRunAiConfigStillOpen({ userId: 'u' }, 'app', platform, null)).not.toThrow();
    expect(() => assertRunAiConfigStillOpen({ userId: 'u' }, 'app', own('ORGANIZATION'), null)).toThrow(/an App a person owns/);
  });
});

describe('#5025 acceptance 7: embedding a person\'s memory is never gated and never debited (cor:dmo:170:05)', () => {
  it('switches on, a zero balance, a priced platform model: the unit is recorded and no ledger entry is written', async () => {
    switchesOn();
    const p = await person('a8embed');
    await platformDefault();
    expect(await creditBalance(db, { userId: p.user.id })).toBe(0n);
    // as embedNodes records it for a memory a person owns (no billable account), and as it would name the person
    for (const billableAccount of [null, { userId: p.user.id }]) {
      const event = await recordLlmUsage(db, {
        type: 'embedding', memoryId: p.memoryId, billableAccount, provider: 'test', model: 'platform-model',
        tokensIn: 10_000, tokensOut: 0, keyOwnerType: 'HADRON_SERVER',
      });
      expect(event).not.toBeNull();
    }
    expect(await db.usageEvent.count({ where: { type: 'embedding', memoryId: p.memoryId } })).toBe(2);
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});
