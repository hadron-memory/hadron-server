/**
 * #670 — the script node (hrn:node:hadronmemory.com:specs:cor:agt:010:04, Decided V50): a flow node whose
 * `data.script.call = { tool, args }` makes one run-tool call with NO model hop. Scenarios S1-S5 of the rule,
 * plus the unknown-tool refusal, output/routing and the one-dispatcher structural pin. Production deps with
 * only the AI-config seam stubbed; the model seams are spies that must stay uncalled. The tool is the real
 * `hadron_create_node` (cost 1, no send), so nothing leaves the process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbRunConsentPrincipal } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { NoAiConfigAvailableError } from '../lib/aiConfig.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

vi.mock('../lib/resendToolClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/resendToolClient.js')>();
  return { ...actual, sendResendEmail: vi.fn(async () => ({ id: 'email_670' })), isResendToolConfigured: vi.fn(() => true) };
});

vi.mock('../lib/webfetchClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/webfetchClient.js')>()),
  httpRequest: vi.fn(),
  getWebfetchContract: vi.fn(async () => ({ contract: 'webfetch@2', capabilities: ['redirects-none'] })),
}));

// Observes the email.send counters at the moment the tool asks for its comm.outbound ticket, which is AFTER both
// quota charges and BEFORE any refund: the one point where "charged, then refunded" is visible (#3148 item 4).
const atTicket = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));
vi.mock('./appRuns.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./appRuns.js')>();
  return {
    ...real,
    consumeActionTicket: vi.fn(async (...args: Parameters<typeof real.consumeActionTicket>) => {
      await atTicket.hook?.();
      return real.consumeActionTicket(...args);
    }),
  };
});

import { httpRequest } from '../lib/webfetchClient.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { sendResendEmail } from '../lib/resendToolClient.js';
import { encryptResendApiKey } from '../lib/resendSenders.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';

const ORG_URN = 'script-org';
const ENTRY = `${ORG_URN}::flowmem::flow:s`;
const TARGET = `${ORG_URN}::flowmem::tasks:from-script`;

let orgId: string;
let appId: string;
let memoryId: string;
let agentId: string;

const makeNode = async (loc: string, extra: Record<string, unknown> = {}) =>
  (await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc.split(':').pop()!, tags: [], ...extra } as never })).id;

const script = (args: Record<string, unknown> = { urn: TARGET, name: 'From script', content: 'made', nodeType: 'info' }, tool = 'hadron_create_node') => ({
  data: { script: { call: { tool, args } } } as never,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: ORG_URN, urn: ORG_URN } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'script-app', urn: `${ORG_URN}::script-app` } })).id;
  memoryId = (await db.memory.create({
    // #3278: PUBLIC gives the userless run reads; explicit prefix grants below give its writes.
    data: { id: generateId(), organizationId: orgId, name: 'flowmem', urn: `${ORG_URN}:flowmem`, class: 'knowledge', visibility: 'PUBLIC' },
  })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'script-agent', urn: `${ORG_URN}:script-agent` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
  await db.agentMemoryItem.create({ data: { agentId, memoryId, role: 'read-write' } });
  const grantor = await createDbRunConsentPrincipal(db, orgId, appId);
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: grantor.userId } }, data: { role: 'ADMIN' } });
  await db.appMemoryWriteGrant.createMany({ data: ['tasks', 'runs'].map(prefix => ({
    appId, memoryId, prefix, grantedBy: grantor.userId,
    registerNodeUrn: 'hrn:node:example.com:fixture:authority',
  })) });
});

function deps(opts: { noConfig?: boolean } = { noConfig: true }) {
  const llm = vi.fn(async () => ({ text: 'x', tokensIn: 5, tokensOut: 5, provider: 'anthropic', model: 'test' }));
  const llmObject = vi.fn();
  const llmTools = vi.fn();
  const resolveConfig = vi.fn(async () => {
    if (opts.noConfig) throw new NoAiConfigAvailableError('default', 'this run');
    return { config: { provider: 'anthropic', model: 'test' } } as never;
  });
  const d: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig, llm, llmObject, llmTools, onTerminal: undefined };
  return { d, llm, llmObject, llmTools, resolveConfig };
}

const mint = async (eventData: Record<string, unknown> = {}) =>
  mintAppRun(db, {
    organizationId: orgId, appId, agentId, triggerKind: 'MANUAL', entryNodeUrn: ENTRY, eventData,
    consentPrincipal: await createDbRunConsentPrincipal(db, orgId, appId),
  });

const failureOf = async (id: string) => (await db.appRun.findUniqueOrThrow({ where: { id } })).failure as { code?: string; message?: string; reason?: string };
const targetNode = () => db.node.findUnique({ where: { loc_memoryId: { loc: 'tasks:from-script', memoryId } } });

describe('script node (#670, cor:agt:010:04)', () => {
  it('S1: an all-script run completes with no AI configuration, calls no model, records zero tokens, costs one action', async () => {
    await makeNode('flow:s', script());
    const run = await mint();
    const { d, llm, llmObject, llmTools } = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    expect((await targetNode())?.name).toBe('From script'); // the call happened, under the run principal
    expect([llm, llmObject, llmTools].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(0);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.tokensSpent).toBe(0);
    const hops = after.hops as Array<Record<string, unknown>>;
    expect(hops[0]).toMatchObject({ tokensSpent: 0, toolCalls: [{ name: 'hadron_create_node', ok: true }] });
    // one action for the call + one for the terminal output write (memory.write), nothing for a model entry
    expect((run.budgetActions ?? 0) - (after.budgetActions ?? 0)).toBe(2);
  });

  it('S2: script then model hop with no AI config: the script call stands, the run fails NO_AI_CONFIG positioned at the model hop', async () => {
    const s = await makeNode('flow:s', script());
    const m = await makeNode('flow:m', { content: 'Summarise.' });
    await db.edge.create({ data: { id: generateId(), memoryId, sourceId: s, targetId: m, name: 'next', loc: deriveEdgeLoc('flow:s', 'next', 'flow:m') } });
    const run = await mint();
    const { d, llm } = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    expect(await targetNode()).not.toBeNull(); // completed script hop stands
    expect((await failureOf(run.id)).code).toBe('NO_AI_CONFIG');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(String(after.curNodeUrn)).toContain('flow:m');
    expect(llm).not.toHaveBeenCalled();
  });

  it('S3: a tool the policy denies is refused by the activation chain and never executes', async () => {
    await makeNode('flow:s', script());
    await db.app.update({ where: { id: appId }, data: { policy: { allow: ['run.execute', 'llm.invoke', 'memory.read', 'memory.write'] } } });
    const run = await mint();
    expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
    const f = await failureOf(run.id);
    expect(f.code).toBe('ACTIVATION_DENIED');
    expect(f.reason).toMatch(/^DENIED_/);
    expect(await targetNode()).toBeNull();
  });

  it('S4: a placeholder with no value refuses the hop before the call, naming the variable', async () => {
    await makeNode('flow:s', script({ urn: TARGET, name: '{{alertName}}', content: 'x', nodeType: 'info' }));
    const run = await mint({});
    expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
    const f = await failureOf(run.id);
    expect(f.code).toBe('SCRIPT_VARIABLE_MISSING');
    expect(f.message).toContain('alertName');
    expect(await targetNode()).toBeNull();
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.budgetActions).toBe(run.budgetActions); // no action used
  });

  it('templates args from the merged view', async () => {
    await makeNode('flow:s', script({ urn: TARGET, name: 'Alert {{who}}', content: 'x', nodeType: 'info' }));
    const run = await mint({ who: 'Ada' });
    expect(await executeAppRun(db, run.id, deps().d)).toBe('completed');
    expect((await targetNode())?.name).toBe('Alert Ada');
  });

  it('S5: script together with tools, or with extractionSpec, is refused at load', async () => {
    for (const extra of [{ tools: ['hadron_log'] }, { extractionSpec: [{ field: 'a' }] }]) {
      await db.node.deleteMany({ where: { memoryId, loc: 'flow:s' } });
      await makeNode('flow:s', { data: { script: { call: { tool: 'hadron_log', args: {} } }, ...extra } as never });
      const run = await mint();
      expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
      expect((await failureOf(run.id)).code).toBe('NODE_LOAD_FAILED');
    }
  });

  it('an unknown tool name is refused at load', async () => {
    await makeNode('flow:s', script({}, 'hadron_teleport'));
    const run = await mint();
    expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
    const f = await failureOf(run.id);
    expect(f.code).toBe('NODE_LOAD_FAILED');
    expect(f.message).toContain('hadron_teleport');
  });

  it('the tool result is the hop output and routing continues to a model hop when a config exists', async () => {
    const s = await makeNode('flow:s', script());
    const m = await makeNode('flow:m', { content: 'Next.' });
    await db.edge.create({ data: { id: generateId(), memoryId, sourceId: s, targetId: m, name: 'next', loc: deriveEdgeLoc('flow:s', 'next', 'flow:m') } });
    const run = await mint();
    const { d, llm } = deps({ noConfig: false });
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    expect(llm).toHaveBeenCalledTimes(1);
    const hops = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).hops as Array<Record<string, unknown>>;
    expect(hops.map((h) => h.tokensSpent)).toEqual([0, 10]);
  });


  // Gizelle P2 (#3143): rule 2 and S1 name an OUTBOUND tool: the quota and ticket of the send must be consumed
  // through the script path exactly as for a model's call. The provider client is a stub: nothing is sent.
  describe('hadron_send_email through a script node: quota, ticket, one action (S1, S4)', () => {
    const emailScript = (args: Record<string, unknown>) => script(args, 'hadron_send_email');
    beforeEach(async () => {
      await db.resendSender.create({
        data: { id: generateId(), organizationId: orgId, fromAddress: 'Acme <agent@acme.example>', apiKeyEncrypted: encryptResendApiKey('re_test_secret') },
      });
    });
    const mintTicket = () => db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId: null, action: 'comm.outbound', mintedBy: 'test' } });
    const quotaUsed = async (scopeKind: 'app' | 'org') =>
      (await db.quotaCounter.findFirst({ where: { scopeKind, scopeId: scopeKind === 'app' ? appId : orgId, action: 'email.send', window: 'day' } }))?.used ?? 0;

    it('sends once with the rendered args, consumes email.send at app and org scope and one comm.outbound ticket, no model, no tokens', async () => {
      await makeNode('flow:s', emailScript({ to: '{{alertEmail}}', subject: 'Alert', text: '{{summary}}' }));
      const ticket = await mintTicket();
      const run = await mint({ alertEmail: 'person@example.net', summary: 'disk full' });
      const { d, llm, llmObject, llmTools } = deps();
      expect(await executeAppRun(db, run.id, d)).toBe('completed');
      expect(sendResendEmail).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendResendEmail).mock.calls[0]![0]).toMatchObject({ to: 'person@example.net', subject: 'Alert', text: 'disk full' });
      expect(await quotaUsed('app')).toBe(1);
      expect(await quotaUsed('org')).toBe(1);
      expect((await db.actionTicket.findUniqueOrThrow({ where: { id: ticket.id } })).consumedByRunId).toBe(run.id);
      expect([llm, llmObject, llmTools].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
      expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).tokensSpent).toBe(0);
    });

    it('with no comm.outbound ticket the send is skipped by the tool, as for a model call: charged, then refunded', async () => {
      await makeNode('flow:s', emailScript({ to: 'person@example.net', subject: 'Alert', text: 'x' }));
      const run = await mint();
      const seen: Array<{ app: number; org: number }> = [];
      atTicket.hook = async () => { seen.push({ app: await quotaUsed('app'), org: await quotaUsed('org') }); };
      try {
        // The tool reports the skip as its result (not a throw), so the hop and the run complete.
        expect(await executeAppRun(db, run.id, deps().d)).toBe('completed');
      } finally {
        atTicket.hook = null;
      }
      expect(sendResendEmail).not.toHaveBeenCalled();
      // Mechanism: both counters were charged when the ticket was asked for, and both are back to 0 afterwards.
      expect(seen).toEqual([{ app: 1, org: 1 }]);
      expect(await quotaUsed('app')).toBe(0);
      expect(await quotaUsed('org')).toBe(0);
      const hops = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).hops as Array<Record<string, unknown>>;
      expect(hops[0]).toMatchObject({ tokensSpent: 0, toolCalls: [{ name: 'hadron_send_email', ok: true }] });
    });

    it('S4 for the send: {{alertEmail}} with no value sends nothing, consumes no quota and no ticket', async () => {
      await makeNode('flow:s', emailScript({ to: '{{alertEmail}}', subject: 'Alert', text: 'x' }));
      const ticket = await mintTicket();
      const run = await mint({});
      expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
      const f = await failureOf(run.id);
      expect(f.code).toBe('SCRIPT_VARIABLE_MISSING');
      expect(f.message).toContain('alertEmail');
      expect(sendResendEmail).not.toHaveBeenCalled();
      expect(await quotaUsed('app')).toBe(0);
      expect((await db.actionTicket.findUniqueOrThrow({ where: { id: ticket.id } })).consumedAt).toBeNull();
    });
  });

  // Gizelle P3: the loader's exclusion follows the import format: present, even empty, counts.
  // #4775 acceptance 1 (cor:sec:030:01): the echo redaction, through the flow runtime rather than at the tool dispatcher.
  it('a web_request script node whose remote echoes the injected credential leaves none of it in the run or the output node', async () => {
    const CANARY = 'canary-4775-flow-VALUE';
    vi.stubEnv('SECRET_ROOT_KEY', '33'.repeat(32));
    try {
      await upsertPlatformActions(db);
      const { userId } = await createDbRunConsentPrincipal(db, orgId, appId);
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId } }, data: { role: 'ADMIN' } });
      const secret = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'token', kind: 'webfetch-auth',
        metadata: { type: 'bearer', urlPrefix: 'https://api.example.test/v1' }, value: { type: 'bearer', token: CANARY } }, { db, userId, roles: [] } as Context);
      const grantId = generateId(); const clientId = generateId();
      await db.$executeRaw`INSERT INTO grants (id, app_id, grantee_app_id, action, action_values, reason, max_uses, created_at, updated_at)
        VALUES (${grantId}, ${appId}, ${appId}, 'secret.use', ${JSON.stringify({ secret: secret.id, 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1', 'binding-header': 'Authorization' })}::jsonb, 'test', 5, now(), now())`;
      await db.secretReadClient.create({ data: { id: clientId, grantId, appId, secretId: secret.id, secretName: 'token', issuerUserId: userId, selfIssued: false } });
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`UPDATE grants SET activated_at = now(), verification_kind = 'passkey', verified_by = ${userId}, issuer_user_id = ${userId} WHERE id = ${grantId}`;
      });
      await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
      const url = 'https://api.example.test/v1/orders';
      vi.mocked(httpRequest).mockImplementation(async (input) => {
        const token = (input as { auth?: { token?: string } }).auth?.token; // echo what was really sent, never a fixture string
        return { method: 'GET', finalUrl: url, status: 200, headers: { 'x-echo': `Bearer ${token}` }, contentType: 'application/json',
          body: { echoed: `Bearer ${token}`, marker: 'echo-body-4775' }, truncated: false } as never;
      });
      await makeNode('flow:s', script({ method: 'GET', url, secretClientId: clientId }, 'web_request'));
      const run = await mint();
      expect(await executeAppRun(db, run.id, deps().d)).toBe('completed');
      expect(vi.mocked(httpRequest).mock.calls).toMatchObject([[{ auth: { type: 'bearer', token: CANARY } }]]);

      // The output node holds the echo, redacted: proof the result reached it, so the absence below is not an empty write.
      const nodes = await db.node.findMany({ where: { memoryId } });
      const output = nodes.filter((n) => JSON.stringify(n).includes('echo-body-4775'));
      expect(output).toHaveLength(1);
      expect(JSON.stringify(output[0])).toContain('[REDACTED]');
      expect(JSON.stringify(nodes)).not.toContain(CANARY);
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(JSON.stringify(after, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(CANARY);
    } finally { vi.unstubAllEnvs(); }
  });

  it('script together with an empty tools or extractionSpec array is also refused at load (as the import format does)', async () => {
    for (const extra of [{ tools: [] }, { extractionSpec: [] }]) {
      await db.node.deleteMany({ where: { memoryId, loc: 'flow:s' } });
      await makeNode('flow:s', { data: { script: { call: { tool: 'hadron_log', args: {} } }, ...extra } as never });
      const run = await mint();
      expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
      const f = await failureOf(run.id);
      expect(f.code).toBe('NODE_LOAD_FAILED');
      // Refused for the exclusion itself, not for some unrelated load fault (#3148).
      expect(f.message).toContain('data.script together with');
    }
  });

  it('a script tool whose handler throws fails the run TOOL_FAILED (the call was admitted, then failed)', async () => {
    await makeNode('flow:s', script({ urn: 'not a urn', name: 'x' }));
    const run = await mint();
    expect(await executeAppRun(db, run.id, deps().d)).toBe('failed');
    expect((await failureOf(run.id)).code).toBe('TOOL_FAILED');
  });

  it('a runner without the script dependency fails RUNNER_NOT_CONFIGURED, not TOOL_FAILED', async () => {
    await makeNode('flow:s', script());
    const run = await mint();
    const { d } = deps();
    expect(await executeAppRun(db, run.id, { ...d, callScript: undefined })).toBe('failed');
    expect((await failureOf(run.id)).code).toBe('RUNNER_NOT_CONFIGURED');
    expect(await targetNode()).toBeNull();
  });

  it('one dispatcher: a run tool\'s execute is invoked from exactly one non-test call site', () => {
    const hits: string[] = [];
    // A tripwire, not a proof: it matches the usual receivers of a RunToolDef's execute. Rooted at this file, not the CWD.
    const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && /\b(?:def|tool|t)\.execute\(/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual(['lib/runner/toolAdmission.ts']);
  });
});
