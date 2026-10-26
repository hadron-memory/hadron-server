/**
 * #2437 — data.output.writeTo destination patterns (epic #2435, gap 6).
 *
 * Build ruling on the issue (Vera, 2026-10-25): expand the pattern FIRST —
 * a CLOSED token set ({runId}, {runTime}; no path traversal, no user text) —
 * THEN check the resulting URN against the write grant at write time; a
 * memory-level grant covers any node under it. Literal writeTo behaviour is
 * unchanged (cor:agt:010:01: writeTo is data, not the automation, so the
 * grant check is the only control on where a run writes).
 *
 * Pins, red at main 9be68aaea (2026-10-26):
 *  1. {runId}: two runs → two distinct nodes under the chosen parent. On
 *     main both runs fail OUTPUT_WRITE_FAILED with InvalidLocError — braces
 *     are not loc atoms (SEGMENT_RE) — the issue's "cannot write a new node
 *     per run" arm.
 *  2. {runTime}: the node lands at <parent>:YYYY-MM-DD-HHMM (UTC) of the
 *     run's startedAt, #2411's report naming. Minute granularity by design:
 *     two runs inside one minute address the same node (mode decides), the
 *     6-hourly schedule of the proof case never does.
 *  3. A destination outside the grant is refused with a plain message that
 *     names the destination and the next step, and nothing is written. On
 *     main the refusal is the generic "Forbidden: no write access to this
 *     memory" (requireMemoryWriteAccess), which names neither.
 *  4. An unknown {token} is refused with a plain message naming the allowed
 *     tokens; nothing is written. On main the braces fail loc validation
 *     instead of being explained.
 *
 * Control, green on main BY DESIGN (acceptance item 3 preserves today):
 *  5. Literal writeTo: two runs append into ONE node exactly as before.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';

const ORG_URN = 'writeto-int-org';
const MEM_URN = `${ORG_URN}:writemem`;
const ENTRY = `${ORG_URN}::writemem::flow:report`;
const UNGATED_URN = `${ORG_URN}:ungated`;

let orgId: string;
let appId: string;
let memoryId: string;
let ungatedMemoryId: string;

/** Point the entry node's data.output at a destination for one test. */
async function setOutput(writeTo: string, mode: 'replace' | 'append'): Promise<void> {
  await db.node.update({
    where: { loc_memoryId: { loc: 'flow:report', memoryId } },
    data: { data: { output: { writeTo, mode } } as never },
  });
}

/** One MANUAL run of the single-node flow; the LLM seam returns `body`. */
async function runOnce(body = 'report body'): Promise<{ runId: string; outcome: string }> {
  const run = await mintAppRun(db, {
    organizationId: orgId,
    appId,
    triggerKind: 'MANUAL',
    entryNodeUrn: ENTRY,
    eventData: {},
  });
  const deps: RunExecutionDeps = {
    ...makeProdRunDeps(db),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm: vi.fn(async () => ({ text: body, tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' })),
    onTerminal: undefined, // webhook callback dispatch is out of scope here
  };
  const outcome = await executeAppRun(db, run.id, deps);
  return { runId: run.id, outcome };
}

async function runFailure(runId: string): Promise<{ code: string; message: string }> {
  const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
  return run.failure as { code: string; message: string };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: ORG_URN, urn: ORG_URN },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'writeto-app', urn: `${ORG_URN}::writeto-app` },
  });
  appId = app.id;
  // The granted destination: the run principal's write access rides the
  // App's installed Agent's memory map (read-write AgentMemoryItem).
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'writemem',
      urn: MEM_URN, class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  memoryId = memory.id;
  // Same org, same class, NO grant — only the grant separates the two.
  const ungated = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'ungated',
      urn: UNGATED_URN, class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  ungatedMemoryId = ungated.id;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: 'writeto-agent', urn: `${ORG_URN}:writeto-agent` },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({
    data: { agentId: agent.id, memoryId, role: 'read-write' },
  });
  await db.node.create({
    data: {
      id: generateId(), memoryId, loc: 'flow:report', name: 'report',
      tags: [], content: 'Produce the report.',
    } as never,
  });
});

describe('data.output.writeTo destination patterns (#2437)', () => {
  it('{runId}: two runs write two distinct nodes under the chosen parent (acceptance 1)', async () => {
    await setOutput(`hrn:node:${ORG_URN}:writemem:reports:capacity:{runId}`, 'replace');
    const a = await runOnce('first');
    const b = await runOnce('second');
    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('completed');

    const na = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: `reports:capacity:${a.runId}`, memoryId } },
    });
    const nb = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: `reports:capacity:${b.runId}`, memoryId } },
    });
    expect(na.id).not.toBe(nb.id);
    expect(na.content).toBe('first');
    expect(nb.content).toBe('second');
    // Both landed UNDER the chosen parent: the exact locs share its prefix,
    // and no literal-brace node was left behind.
    expect(await db.node.findUnique({
      where: { loc_memoryId: { loc: 'reports:capacity:{runId}', memoryId } },
    })).toBeNull();
  });

  it('{runTime}: the node lands at the run\'s UTC YYYY-MM-DD-HHMM (acceptance 1, #2411 naming)', async () => {
    await setOutput(`hrn:node:${ORG_URN}:writemem:reports:daily:{runTime}`, 'replace');
    const { runId, outcome } = await runOnce();
    expect(outcome).toBe('completed');

    const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
    const t = run.startedAt!;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`;
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: `reports:daily:${stamp}`, memoryId } },
    });
    expect(node.content).toBe('report body');
  });

  it('a destination outside the grant is refused with a plain message and writes nothing (acceptance 2)', async () => {
    await setOutput(`hrn:node:${ORG_URN}:ungated:reports:leak:{runId}`, 'replace');
    const { runId, outcome } = await runOnce();
    expect(outcome).toBe('failed');

    const failure = await runFailure(runId);
    expect(failure.code).toBe('OUTPUT_WRITE_FAILED');
    // Plain message: names the destination and the next step, no ids or hashes.
    expect(failure.message).toContain(UNGATED_URN);
    expect(failure.message).toMatch(/not granted/i);
    // A refused destination leaves no artifact.
    expect(await db.node.count({ where: { memoryId: ungatedMemoryId } })).toBe(0);
  });

  it('an unknown token is refused with a plain message naming the allowed tokens, and writes nothing', async () => {
    const before = await db.node.count({ where: { memoryId } });
    await setOutput(`hrn:node:${ORG_URN}:writemem:reports:{topic}`, 'replace');
    const { runId, outcome } = await runOnce();
    expect(outcome).toBe('failed');

    const failure = await runFailure(runId);
    expect(failure.code).toBe('OUTPUT_WRITE_FAILED');
    expect(failure.message).toContain('{runId}');
    expect(failure.message).toContain('{runTime}');
    expect(await db.node.count({ where: { memoryId } })).toBe(before);
  });

  it('literal writeTo: two runs still append into ONE node, exactly as before (acceptance 3 — control)', async () => {
    await setOutput(`hrn:node:${ORG_URN}:writemem:flow:alerts`, 'append');
    await runOnce('first');
    await runOnce('second');
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'flow:alerts', memoryId } },
    });
    expect(node.content).toBe('first\n\n---\n\nsecond');
  });
});
