/**
 * hadron-server#5023 (Billing A3): the credit gate (hrn:node:hadronmemory.com:specs:cor:acl:050:05). With debits and the gate
 * switch on, platform-key work of an owner at zero credit is refused BEFORE it starts: at run launch (before any quota
 * counter moves), at each model hop (stored DENIED_CREDITS), and never for own-key work, a script hop, or work with no
 * billable account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbRunConsentPrincipal, createPriceRowForTest } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { encryptToken } from '../lib/tokenCrypto.js';
import { clearPriceCache, grantCredits, creditBalance } from '../lib/metering/index.js';
import { reloadOwnerDefaultMonthlyGrantForTests, resetPeriodGrantStateForTests } from '../lib/metering/periodGrant.js';
import { CREDITS_EXHAUSTED_MESSAGE, CREDIT_GATE_MEMO_MAX, CREDIT_GATE_MEMO_TTL_MS, memoRememberForTests, requireCreditHeadroom, resetCreditGateMemoForTests } from '../lib/metering/gate.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { plainRunFailure } from '../lib/automation/plainReason.js';
import { generateWebhookSecret, mintWebhookPlatformToken, mountWebhookRoutes } from '../api/webhooks.js';
import { schedulerTick } from './scheduler.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

import { mintAppRun, executeAppRun, RunLaunchDeniedError, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';
import { activeMemoryWriteGrant } from '../test/appGrants5404.js';

const ORG_URN = 'credit-gate-org';
const mem = `${ORG_URN}::flowmem`;
let orgId: string, appId: string, memoryId: string, agentId: string, hostId: string;

const makeNode = async (loc: string, extra: Record<string, unknown> = {}) =>
  (await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc.split(':').pop()!, tags: [], ...extra } as never })).id;

/** The two switches on, as a deployment that sells credit has them. */
const switchesOn = () => {
  vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
  vi.stubEnv('BILLING_CREDIT_GATE_ENABLED', 'true');
};

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  clearPriceCache();
  resetPeriodGrantStateForTests();
  resetCreditGateMemoForTests();
  reloadOwnerDefaultMonthlyGrantForTests({});
  orgId = (await db.organization.create({ data: { id: generateId(), name: ORG_URN, urn: ORG_URN } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'gate-app', urn: `${ORG_URN}::gate-app` } })).id;
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: orgId, name: 'flowmem', urn: `${ORG_URN}:flowmem`, class: 'knowledge', visibility: 'PUBLIC' },
  })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'gate-agent', urn: `${ORG_URN}:gate-agent` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
  await db.agentMemoryItem.create({ data: { agentId, memoryId, role: 'read-write' } });
  const grantor = await createDbRunConsentPrincipal(db, orgId, appId);
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: grantor.userId } }, data: { role: 'ADMIN' } });
  // #5404: the App's write authority is a signed `memory.write` grant per prefix (ruling 0083's unsigned rows are retired),
  // signed by the org ADMIN, who manages the memory.
  for (const prefix of ['tasks', 'runs', 'flow']) await activeMemoryWriteGrant(appId, memoryId, { issuerUserId: grantor.userId, prefix });
  // a two-hop flow (a -> b) and a flow whose second hop is a script (a -> s)
  const a = await makeNode('flow:a', { content: 'Say hello.' });
  const b = await makeNode('flow:b', { content: 'Say goodbye.' });
  const s = await makeNode('flow:s', { data: { script: { call: { tool: 'hadron_create_node', args: { urn: `${mem}::tasks:from-script`, name: 'From script', content: 'made', nodeType: 'info' } } } } as never });
  await db.edge.createMany({ data: [
    { id: generateId(), memoryId, sourceId: a, targetId: b, name: 'next', loc: deriveEdgeLoc('flow:a', 'next', 'flow:b') },
  ] });
  void s;
  // a price row, and the platform's own default configuration (the walk reaches the platform level)
  await createPriceRowForTest(db, { data: { id: generateId(), provider: 'anthropic', model: 'test', tier: 1, inputMicroCentsPerMTok: 30_000_000n, outputMicroCentsPerMTok: 150_000_000n, effectiveAt: new Date('2020-01-01') } });
  hostId = (await db.hadronServer.create({ data: { id: generateId(), url: 'https://credit-gate.hadron.local' } })).id;
  await db.aiServiceConfig.create({ data: { name: 'default', provider: 'anthropic', model: 'test', hadronServerId: hostId } as never });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clockSkewMs = 0;
});

const mint = async (entry = 'flow:a', over: Record<string, unknown> = {}) =>
  mintAppRun(db, {
    owner: { organizationId: orgId }, appId, agentId, triggerKind: 'MANUAL', entryNodeUrn: `${mem}::${entry}`, eventData: {},
    consentPrincipal: await createDbRunConsentPrincipal(db, orgId, appId), ...over,
  } as never);
const ownKeyConfig = () =>
  db.aiServiceConfig.create({ data: { name: 'default', provider: 'anthropic', model: 'test', appId, apiKeyEncrypted: encryptToken('sk-own-0123456789'), apiKeyPreview: '…6789' } as never });
const denial = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as RunLaunchDeniedError; } };
const counters = () => db.quotaCounter.count({ where: { action: 'run.execute' } });

/** The process clock as the gate's memo reads it: a test moves it forward instead of waiting. */
let clockSkewMs = 0;
function runDeps(opts: { skewAfterFirstCallMs?: number } = {}): { deps: RunExecutionDeps; llm: ReturnType<typeof vi.fn> } {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + clockSkewMs);
  const llm = vi.fn(async () => {
    // the hop took longer than the memo's window: the next hop is judged against the ledger again
    if (opts.skewAfterFirstCallMs) clockSkewMs += opts.skewAfterFirstCallMs;
    return { text: 'ok', tokensIn: 100, tokensOut: 50, provider: 'anthropic', model: 'test' };
  });
  return {
    llm,
    deps: {
      ...makeProdRunDeps(db),
      resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' }, ownerType: 'HADRON_SERVER' }) as never),
      llm, onTerminal: undefined,
    },
  };
}
const failureOf = async (id: string) => (await db.appRun.findUniqueOrThrow({ where: { id } })).failure as { code?: string; message?: string; reason?: string };

describe('pin 1 and 2: the launch', () => {
  it('a platform-key launch at a zero balance is refused CREDITS_EXHAUSTED, before any run row or quota counter', async () => {
    switchesOn();
    const err = await denial(mint());
    expect(err).toBeInstanceOf(RunLaunchDeniedError);
    expect(err!.code).toBe('CREDITS_EXHAUSTED');
    expect(await db.appRun.count()).toBe(0);
    expect(await counters()).toBe(0); // neither the App's nor the organization's run counter moved
  });

  it('a balance below zero is refused too, and a balance of one micro-cent launches (the bound is <= 0)', async () => {
    switchesOn();
    await grantCredits(db, { owner: { organizationId: orgId }, amountMicroCents: 1n, sourceType: 't', sourceId: 'one' });
    expect((await mint()).status).toBe('PENDING');
    await db.creditLedgerEntry.create({ data: { id: generateId(), organizationId: orgId, kind: 'adjustment', amountMicroCents: -5n, sourceType: 't', sourceId: 'neg' } });
    expect(await creditBalance(db, { organizationId: orgId })).toBe(-4n);
    resetCreditGateMemoForTests(); // the launch above memoised a positive balance; this one judges the new one
    expect((await denial(mint()))!.code).toBe('CREDITS_EXHAUSTED');
  });

  it('a launch on a configuration of the App itself (its own key) is never gated', async () => {
    switchesOn();
    await ownKeyConfig();
    expect((await mint()).status).toBe('PENDING');
  });
});

describe('pin 3: the switch is the exact value true, and needs debits on', () => {
  it.each(['TRUE', '1', ' true', 'false', '', 'yes'])('BILLING_CREDIT_GATE_ENABLED=%j: the zero-balance launch is not refused', async (v) => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('BILLING_CREDIT_GATE_ENABLED', v);
    expect((await mint()).status).toBe('PENDING');
  });
  it('unset, and debits off: not refused', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    expect((await mint()).status).toBe('PENDING');
    vi.unstubAllEnvs();
    vi.stubEnv('BILLING_CREDIT_GATE_ENABLED', 'true');
    expect((await mint()).status).toBe('PENDING');
  });
});

describe('pin 11: an expired, unsettled grant is not credit', () => {
  it('only an expired grant (the stored sum is positive): the gate settles it first and refuses', async () => {
    switchesOn();
    const past = new Date(Date.now() - 3_600_000);
    await db.creditLedgerEntry.create({
      data: { id: generateId(), organizationId: orgId, kind: 'grant', amountMicroCents: 1000n, sourceType: 't', sourceId: 'old', createdAt: new Date(past.getTime() - 86_400_000), expiresAt: past },
    });
    expect(await creditBalance(db, { organizationId: orgId })).toBe(1000n);
    expect((await denial(mint()))!.code).toBe('CREDITS_EXHAUSTED');
  });
});

describe('pin 9 and 10: each model hop; never a script hop', () => {
  it('a run that started with credit and spent it fails at its next model hop DENIED_CREDITS, with no model call for that hop', async () => {
    switchesOn();
    await grantCredits(db, { owner: { organizationId: orgId }, amountMicroCents: 1n, sourceType: 't', sourceId: 'one' });
    const run = await mint('flow:a');
    const { deps, llm } = runDeps({ skewAfterFirstCallMs: CREDIT_GATE_MEMO_TTL_MS + 1 });
    expect(await executeAppRun(db, run.id, deps)).toBe('failed');
    expect(llm).toHaveBeenCalledTimes(1); // hop 1 ran; hop 2 was refused before its model call
    const f = await failureOf(run.id);
    expect(f).toMatchObject({ code: 'ACTIVATION_DENIED', reason: 'DENIED_CREDITS' });
    expect(f.message).toBe(CREDITS_EXHAUSTED_MESSAGE);
    expect(await creditBalance(db, { organizationId: orgId })).toBeLessThan(0n);
  });

  it('a model hop on an own-key configuration is never gated, even at a balance below zero (local review P3)', async () => {
    switchesOn();
    await ownKeyConfig(); // the launch resolves the App's own key too, so it is not gated either
    const run = await mint('flow:a', {});
    // the run's resolved configuration is the App's own key at its hops, whatever the credit
    const { deps, llm } = runDeps();
    (deps.resolveConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ config: { provider: 'anthropic', model: 'test' }, ownerType: 'APP' });
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    expect(llm).toHaveBeenCalledTimes(2); // both hops ran
  });

  it('a script hop after the balance reached zero still runs: it makes no model call', async () => {
    switchesOn();
    await grantCredits(db, { owner: { organizationId: orgId }, amountMicroCents: 1n, sourceType: 't', sourceId: 'one' });
    // a -> s: replace the a -> b edge with a -> s
    await db.edge.deleteMany({ where: { memoryId } });
    const [a, s] = await Promise.all([db.node.findFirstOrThrow({ where: { memoryId, loc: 'flow:a' } }), db.node.findFirstOrThrow({ where: { memoryId, loc: 'flow:s' } })]);
    await db.edge.create({ data: { id: generateId(), memoryId, sourceId: a.id, targetId: s.id, name: 'next', loc: deriveEdgeLoc('flow:a', 'next', 'flow:s') } });
    const run = await mint('flow:a');
    const { deps, llm } = runDeps();
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(await db.node.findFirst({ where: { memoryId, loc: 'tasks:from-script' } })).not.toBeNull();
  });
});

describe('blind review F12 and F13: the refusal order, and the GraphQL launch door', () => {
  it('ruling 1a: an owner at zero whose Agent has no servable boot prompt gets CREDITS_EXHAUSTED; with an own key it gets the boot-prompt refusal', async () => {
    switchesOn();
    await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: null, bootPromptUrn: null } });
    expect((await denial(mint()))!.code).toBe('CREDITS_EXHAUSTED');
    await ownKeyConfig();
    const e = (await denial(mint())) as unknown as { code?: string; extensions?: { code?: string } } | null;
    expect(e?.code ?? e?.extensions?.code).toBe('BOOT_PROMPT_NOT_SET');
  });

  it('triggerAppRun answers extensions.code CREDITS_EXHAUSTED and writes no run', async () => {
    switchesOn();
    const admin = await db.user.create({ data: { id: generateId(), handle: 'cg-admin', githubId: 502310, roles: ['ADMIN'] } });
    await expect(
      resolvers.Mutation.triggerAppRun({}, { input: { appRef: appId, entryNodeUrn: `${mem}::flow:a` } }, { db, roles: ['ADMIN'], userId: admin.id, clientId: `user:${admin.id}` } as never),
    ).rejects.toMatchObject({ extensions: { code: 'CREDITS_EXHAUSTED' } });
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('blind review F2: what the gate checks is what the hop debits', () => {
  it('the launch gate, the hop gate and the hop\'s usage record all name the run\'s account through billableAccountOfRun', () => {
    const src = readFileSync(join(__dirname, 'appRuns.ts'), 'utf8');
    expect((src.match(/billableAccountOfRun\(/g) ?? []).length).toBe(3);
  });
});

describe('blind review F14: the memo is bounded', () => {
  it('past the bound the memo is cleared and never grows beyond it', () => {
    resetCreditGateMemoForTests();
    let size = 0;
    for (let i = 0; i <= CREDIT_GATE_MEMO_MAX + 5; i++) size = memoRememberForTests({ organizationId: `bound-${i}` });
    expect(size).toBeLessThanOrEqual(CREDIT_GATE_MEMO_MAX);
    expect(size).toBeGreaterThan(0); // the newest owner is held
  });
});

describe('pin 14 and 15: the refusal says nothing about the account, and a client reads it in plain words', () => {
  it('the message names no amount and no owner', async () => {
    expect(CREDITS_EXHAUSTED_MESSAGE).not.toMatch(/\d/);
    switchesOn();
    const err = await denial(mint());
    expect(err!.message).toBe(CREDITS_EXHAUSTED_MESSAGE);
    expect(err!.message).not.toContain(orgId);
    expect(err!.message).not.toContain(ORG_URN);
  });
  it('a DENIED_CREDITS run is the OUT_OF_CREDIT kind, not OTHER', () => {
    const r = plainRunFailure({ status: 'FAILED', failure: { code: 'ACTIVATION_DENIED', reason: 'DENIED_CREDITS', message: CREDITS_EXHAUSTED_MESSAGE } } as never);
    expect(r?.kind).toBe('OUT_OF_CREDIT');
    expect(plainRunFailure({ status: 'FAILED', failure: { code: 'ACTIVATION_DENIED', reason: 'DENIED_BUDGET' } } as never)?.kind).toBe('OVER_BUDGET');
  });
});

describe('the helper', () => {
  it('no billable account passes, whatever the switches', async () => {
    switchesOn();
    await expect(requireCreditHeadroom(db, null)).resolves.toBeUndefined();
  });

  it('INSIDE a caller\'s transaction it writes nothing and counts the month\'s grant that is due (ruling 8a)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"500"}' });
    resetPeriodGrantStateForTests();
    const uid = (await db.user.create({ data: { id: generateId(), githubId: 50_230_001, githubUsername: 'gate-u1', handle: 'gate-u1', roles: ['READER'] } })).id;
    const past = new Date(Date.now() - 3_600_000);
    await db.creditLedgerEntry.create({
      data: { id: generateId(), ownerUserId: uid, kind: 'grant', amountMicroCents: 100n, sourceType: 't', sourceId: 'old', createdAt: new Date(past.getTime() - 86_400_000), expiresAt: past },
    });
    const before = await db.creditLedgerEntry.count();
    await db.$transaction(async (tx) => {
      // the grant due (500) is counted, the expired remainder (100) is subtracted: balance 500 > 0, so no refusal
      await requireCreditHeadroom(tx as never, { userId: uid });
    });
    expect(await db.creditLedgerEntry.count()).toBe(before); // wrote neither the grant nor a settlement
  });

  it('INSIDE a caller\'s transaction an expired, unsettled grant is subtracted: with only that grant the call is refused and nothing is written (local review P2)', async () => {
    const past = new Date(Date.now() - 3_600_000);
    await db.creditLedgerEntry.create({
      data: { id: generateId(), organizationId: orgId, kind: 'grant', amountMicroCents: 1000n, sourceType: 't', sourceId: 'old-tx', createdAt: new Date(past.getTime() - 86_400_000), expiresAt: past },
    });
    expect(await creditBalance(db, { organizationId: orgId })).toBe(1000n); // the stored sum still counts it
    const before = await db.creditLedgerEntry.count();
    await expect(db.$transaction(async (tx) => requireCreditHeadroom(tx as never, { organizationId: orgId }))).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' });
    expect(await db.creditLedgerEntry.count()).toBe(before);
  });

  it('outside a transaction it ensures the month\'s grant and settles an expired one before judging', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"500"}' });
    resetPeriodGrantStateForTests();
    const uid = (await db.user.create({ data: { id: generateId(), githubId: 50_230_002, githubUsername: 'gate-u2', handle: 'gate-u2', roles: ['READER'] } })).id;
    await requireCreditHeadroom(db, { userId: uid });
    expect(await creditBalance(db, { userId: uid })).toBe(500n);
  });
});

describe('ruling 7 (Holger, option b): the 5 s positive-balance memo', () => {
  const grant = (n: bigint, id: string) => grantCredits(db, { owner: { organizationId: orgId }, amountMicroCents: n, sourceType: 't', sourceId: id });
  const drain = () => db.creditLedgerEntry.create({ data: { id: generateId(), organizationId: orgId, kind: 'adjustment', amountMicroCents: -10_000n, sourceType: 't', sourceId: generateId() } });
  const owner = () => ({ organizationId: orgId });
  const refused = async () => { try { await requireCreditHeadroom(db, owner()); return false; } catch { return true; } };
  let skew = 0;
  beforeEach(() => {
    skew = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
    switchesOn();
  });

  it('a positive balance is admitted from the memo inside the window even after the ledger went negative', async () => {
    await grant(1000n, 'm1');
    expect(await refused()).toBe(false); // reads the ledger, memoises
    await drain();
    expect(await creditBalance(db, owner())).toBeLessThan(0n); // the ledger is the truth, and every read still sums it
    expect(await refused()).toBe(false); // admitted from the memo
  });

  it('after the window the gate reads the ledger again and refuses', async () => {
    await grant(1000n, 'm2');
    expect(await refused()).toBe(false);
    await drain();
    skew = CREDIT_GATE_MEMO_TTL_MS + 1;
    expect(await refused()).toBe(true);
  });

  it('a zero or negative balance is never memoised: credit added afterwards admits at once, and a refusal is never replayed', async () => {
    expect(await refused()).toBe(true); // zero
    expect(await refused()).toBe(true); // and again at once: a refusal is never memoised into an admission
    await grant(1000n, 'm3');
    expect(await refused()).toBe(false); // not a cached refusal
    await drain();
    skew = CREDIT_GATE_MEMO_TTL_MS + 1;
    expect(await refused()).toBe(true);
    await grant(50_000n, 'm3b');
    expect(await refused()).toBe(false);
  });

  it('the memo is neither read nor written inside a caller\'s transaction', async () => {
    await grant(1000n, 'm4');
    expect(await refused()).toBe(false); // memoised outside
    await drain();
    // inside a transaction the gate computes: it refuses although the memo holds a positive entry
    await expect(db.$transaction(async (tx) => requireCreditHeadroom(tx as never, owner()))).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' });
    // and a positive balance judged inside a transaction seeds nothing
    resetCreditGateMemoForTests();
    await grant(50_000n, 'm4b');
    await db.$transaction(async (tx) => requireCreditHeadroom(tx as never, owner()));
    await drain();
    await drain();
    await drain();
    await drain();
    await drain();
    expect(await refused()).toBe(true); // nothing was memoised by the transaction's call
  });

  it('the memo is per owner: one owner\'s positive balance admits nobody else', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'cg-other', urn: 'cg-other' } })).id;
    await grant(1000n, 'm5');
    expect(await refused()).toBe(false);
    await expect(requireCreditHeadroom(db, { organizationId: other })).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' });
  });
});

describe('pin 13: embedding and every other path is outside the gate', () => {
  it('the gate is called from the launch, the hop and the configuration test only', () => {
    const root = join(__dirname, '..');
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && /metering\/gate\.js/.test(readFileSync(p, 'utf8'))) users.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(users.sort()).toEqual(['controller/operations/testAiServiceConfig.ts', 'jobs/appRuns.ts']);
  });
});

describe('the doors', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

  it('webhook: HTTP 429 { error: CREDITS_EXHAUSTED }, no run', async () => {
    switchesOn();
    const secret = generateWebhookSecret();
    const hook = await db.agentWebhook.create({ data: { id: generateId(), organizationId: orgId, appId, agentId, name: 'notify', secret, entryNodeUrn: `${mem}::flow:a` } as never });
    const hpt = await mintWebhookPlatformToken(hook.id);
    const ex = express();
    ex.use(express.json());
    mountWebhookRoutes(ex, db);
    await new Promise<void>((r) => { server = ex.listen(0, () => r()); });
    const addr = server!.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const res = await fetch(`${base}/hooks/${secret}/notify?hpt=${hpt}`);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'CREDITS_EXHAUSTED' });
    expect(await db.appRun.count()).toBe(0);
  });

  it('scheduler: the denial is logged, the schedule stays enabled, no run', async () => {
    switchesOn();
    const s = await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, name: 'tick', cron: '0 7 * * *', timezone: 'UTC', agentId, entryNodeUrn: `${mem}::flow:a`, enabled: true, nextRunAt: new Date(Date.now() - 60_000) } as never });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await schedulerTick(db)).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('CREDITS_EXHAUSTED'))).toBe(true);
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } })).enabled).toBe(true);
    expect(await db.appRun.count()).toBe(0);
  });
});
