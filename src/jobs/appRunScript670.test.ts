/**
 * #670 — the script node (hrn:node:hadronmemory.com:specs:cor:agt:010:04, Decided V50): a flow node whose
 * `data.script.call = { tool, args }` makes one run-tool call with NO model hop. Scenarios S1-S5 of the rule,
 * plus the unknown-tool refusal, output/routing and the one-dispatcher structural pin. Production deps with
 * only the AI-config seam stubbed; the model seams are spies that must stay uncalled. The tool is the real
 * `hadron_create_node` (cost 1, no send), so nothing leaves the process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbRunConsentPrincipal } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { NoAiConfigAvailableError } from '../lib/aiConfig.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

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
    data: { id: generateId(), organizationId: orgId, name: 'flowmem', urn: `${ORG_URN}:flowmem`, class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'script-agent', urn: `${ORG_URN}:script-agent` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
  await db.agentMemoryItem.create({ data: { agentId, memoryId, role: 'read-write' } });
});

function deps(opts: { noConfig?: boolean } = { noConfig: true }) {
  const llm = vi.fn(async () => ({ text: 'x', tokensIn: 5, tokensOut: 5, provider: 'anthropic', model: 'test' }));
  const llmObject = vi.fn();
  const llmTools = vi.fn();
  const resolveConfig = vi.fn(async () => {
    if (opts.noConfig) throw new NoAiConfigAvailableError('no AI configuration');
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

  it('one dispatcher: a run tool\'s execute is invoked from exactly one non-test call site', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && /\bdef\.execute\(/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual(['src/lib/runner/toolAdmission.ts']);
  });
});
