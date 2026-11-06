/**
 * plan-spawn — fan-out lifecycle (real hadron_test DB, bus mocked, LLM
 * deps injected). Pins D-SP-1..7: config on the spawn column, children
 * through the real launch gate, the exactly-once callback claim under
 * repeated completion signals, item-callbacks once per child, the
 * cancelled-last-child case, partial-denial-as-data, the depth cap, and
 * the hadron_child_runs scope rules.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';

vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

import {
  mintAppRun,
  executeAppRun,
  handleSpawnCompletion,
  setQuotaLimit,
  type RunExecutionDeps,
} from './appRuns.js';
import { runContext } from './appRunDeps.js';
import { hadronSpawn, hadronChildRuns } from '../lib/runner/tools/index.js';
import type { AppRun } from '../generated/prisma/index.js';

let orgId: string;
let appId: string;
let agentId: string;

const ENTRY = 'spawn-org::spawnmem::flow:digest';
const CHILD_ENTRY = 'spawn-org::spawnmem::flow:process-item';
const CALLBACK = 'spawn-org::spawnmem::flow:digest-done';
const ITEM_CALLBACK = 'spawn-org::spawnmem::flow:item-done';

function deps(overrides: Partial<RunExecutionDeps> = {}): RunExecutionDeps {
  return {
    verifyAutomation: vi.fn(async () => undefined),
    assemble: vi.fn(async () => '# Step'),
    loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: null })),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm: vi.fn(async () => ({ text: 'ok', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' })),
    llmObject: vi.fn(async () => ({ object: {}, tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test' })),
    llmTools: vi.fn(async () => ({ text: 'x', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test', toolCalls: [] })),
    writeOutput: vi.fn(async () => null),
    selectNext: vi.fn(async () => null),
    ...overrides,
  };
}

async function mintParent(eventData: Record<string, unknown> = { topic: 'digest' }): Promise<AppRun> {
  return mintAppRun(db, {
    organizationId: orgId, appId, agentId, triggerKind: 'MANUAL', entryNodeUrn: ENTRY, eventData,
  });
}

function toolCtx(run: AppRun) {
  return { log: vi.fn(), db, run, principal: runContext(db, run) };
}

async function spawn3(parent: AppRun, extra: Record<string, unknown> = {}) {
  return hadronSpawn.execute(toolCtx(parent), {
    items: ['a', 'b', 'c'],
    process_item: CHILD_ENTRY,
    item_key: 'note',
    ...extra,
  }) as Promise<{ spawned: number; denied: number }>;
}

async function children(parentId: string) {
  const rows = await db.appRun.findMany({ where: { parentRunId: parentId }, orderBy: { createdAt: 'asc' } });
  return rows.filter((r) => !(r.eventData as Record<string, unknown> | null)?.__spawnCallback);
}

async function callbackRuns(parentId: string, entry: string) {
  return db.appRun.findMany({ where: { parentRunId: parentId, entryNodeUrn: entry } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'spawn-org', urn: 'spawn-org' },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'spawn-app', urn: 'spawn-org::spawn-app' },
  });
  appId = app.id;
  // #2712: a run needs an installed Agent with a served boot prompt (R74); children inherit it.
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'spawn-agent', urn: 'spawn-org:spawn-agent' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
});

describe('hadron_spawn — dispatch (D-SP-1/-3/-5)', () => {
  it('mints one child per item through the real launch gate, parent view + item as payload', async () => {
    const parent = await mintParent({ topic: 'digest', __aiConfigName: 'plumbing' });
    const out = await spawn3(parent, { callback: CALLBACK });
    expect(out).toEqual({ spawned: 3, denied: 0 });

    const kids = await children(parent.id);
    expect(kids).toHaveLength(3);
    expect(kids.map((k) => (k.eventData as Record<string, unknown>).note)).toEqual(['a', 'b', 'c']);
    // Parent view inherited; __-plumbing did NOT leak into children (D-SP-3).
    expect((kids[0].eventData as Record<string, unknown>).topic).toBe('digest');
    expect((kids[0].eventData as Record<string, unknown>).__aiConfigName).toBeUndefined();
    expect(kids.every((k) => k.triggerKind === 'SPAWN' && k.triggerId === parent.id)).toBe(true);

    const fresh = await db.appRun.findUniqueOrThrow({ where: { id: parent.id } });
    const cfg = fresh.spawn as Record<string, unknown>;
    expect(cfg).toMatchObject({ processItem: CHILD_ENTRY, itemKey: 'note', callback: CALLBACK, total: 3 });
    expect(cfg.dispatching).toBeUndefined(); // guard dropped after dispatch
  });

  it('per-item quota denial is DATA, not an exception; zero-spawned throws (D-SP-5)', async () => {
    // Parent mint consumes 1; cap at 2 → exactly one child fits.
    await setQuotaLimit(db, 'app', appId, 'run.execute', 2);
    const parent = await mintParent();
    const out = await spawn3(parent);
    expect(out.spawned).toBe(1);
    expect(out.denied).toBe(2);
    expect(await children(parent.id)).toHaveLength(1);

    // Nothing fits at all → malfunction → throw (→ TOOL_FAILED in the loop).
    const parent2 = await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgId, appId, agentId, triggerKind: 'MANUAL',
        entryNodeUrn: ENTRY, status: 'RUNNING',
      },
    });
    await expect(spawn3(parent2 as AppRun, { callback: CALLBACK })).rejects.toThrow(/no children could be spawned/);
    // The config is fully removed — a failed fan-out can never fire a
    // zero-children callback later (PR-547 review, Gemini).
    const after = await db.appRun.findUniqueOrThrow({ where: { id: parent2.id } });
    expect(after.spawn).toBeNull();
  });

  it('a second spawn on the same run is rejected (one fan-out per run, v1)', async () => {
    const parent = await mintParent();
    await spawn3(parent);
    await expect(spawn3(parent)).rejects.toThrow(/already fanned out/);
  });

  it('the depth cap stops fork bombs (D-SP-7): a grandchild-lineage run cannot spawn', async () => {
    const grandparent = await mintParent();
    const parent = await mintAppRun(db, {
      organizationId: orgId, appId, agentId, triggerKind: 'SPAWN', triggerId: grandparent.id,
      parentRunId: grandparent.id, entryNodeUrn: CHILD_ENTRY,
    });
    // Lineage depth 1 → allowed.
    expect((await spawn3(parent)).spawned).toBe(3);
    const grandchild = (await children(parent.id))[0];
    // Lineage depth 2 → denied.
    await expect(spawn3(grandchild)).rejects.toThrow(/spawn depth/);
  });
});

describe('spawn completion — callbacks (D-SP-4)', () => {
  it('the callback fires EXACTLY once when the last child terminates, with the tally', async () => {
    const parent = await mintParent();
    await spawn3(parent, { callback: CALLBACK });
    const kids = await children(parent.id);
    const d = deps();
    // First two completions: no callback yet.
    await executeAppRun(db, kids[0].id, d);
    await executeAppRun(db, kids[1].id, deps({ assemble: vi.fn(async () => { throw new Error('bad node'); }) }));
    expect(await callbackRuns(parent.id, CALLBACK)).toHaveLength(0);
    // Last child completes → callback minted once.
    await executeAppRun(db, kids[2].id, d);
    const cbs = await callbackRuns(parent.id, CALLBACK);
    expect(cbs).toHaveLength(1);
    expect(cbs[0].eventData).toMatchObject({
      parentRunId: parent.id, total: 3, completed: 2, failed: 1, __spawnCallback: true,
    });
    // Duplicate completion signals (bus redelivery, races) change nothing.
    await handleSpawnCompletion(db, kids[2].id);
    await handleSpawnCompletion(db, kids[0].id);
    expect(await callbackRuns(parent.id, CALLBACK)).toHaveLength(1);
  });

  it('item-callbacks fire once per child with the child outcome + item (D19)', async () => {
    const parent = await mintParent();
    await spawn3(parent, { item_callback: ITEM_CALLBACK });
    const kids = await children(parent.id);
    const d = deps();
    for (const k of kids) await executeAppRun(db, k.id, d);
    const itemCbs = await callbackRuns(parent.id, ITEM_CALLBACK);
    expect(itemCbs).toHaveLength(3);
    const ev = itemCbs.map((c) => c.eventData as Record<string, unknown>);
    expect(new Set(ev.map((e) => e.childRunId))).toEqual(new Set(kids.map((k) => k.id)));
    expect(ev.every((e) => e.childStatus === 'COMPLETED' && e.__spawnCallback === true)).toBe(true);
    expect(new Set(ev.map((e) => e.note))).toEqual(new Set(['a', 'b', 'c'])); // the item rides along
    // Item-callback runs never count toward (or trigger) the final callback.
  });

  it('a CANCELLED last child still fires the callback (the cancel resolver call site)', async () => {
    const parent = await mintParent();
    await spawn3(parent, { callback: CALLBACK });
    const kids = await children(parent.id);
    const d = deps();
    await executeAppRun(db, kids[0].id, d);
    await executeAppRun(db, kids[1].id, d);
    // Cancel the straggler — what cancelAppRun does, then its hook.
    const cancelled = await db.appRun.updateMany({
      where: { id: kids[2].id, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), failure: { code: 'CANCELLED' } },
    });
    expect(cancelled.count).toBe(1);
    await handleSpawnCompletion(db, kids[2].id);
    const cbs = await callbackRuns(parent.id, CALLBACK);
    expect(cbs).toHaveLength(1);
    expect(cbs[0].eventData).toMatchObject({ completed: 2, cancelled: 1 });
  });

  it('the dispatch guard blocks a premature callback; the terminal parent clears a stuck guard (D-SP-4)', async () => {
    const parent = await mintParent();
    await spawn3(parent, { callback: CALLBACK });
    const kids = await children(parent.id);
    const d = deps();
    for (const k of kids) await executeAppRun(db, k.id, d);
    expect(await callbackRuns(parent.id, CALLBACK)).toHaveLength(1); // sanity: fired normally

    // Now the crash shape: guard stuck true, all children already terminal.
    const parent2 = await mintParent();
    await spawn3(parent2, { callback: CALLBACK });
    const kids2 = await children(parent2.id);
    await db.$executeRaw`
      UPDATE app_runs SET spawn = spawn || '{"dispatching": true}'::jsonb WHERE id = ${parent2.id}`;
    for (const k of kids2) await executeAppRun(db, k.id, d);
    expect(await callbackRuns(parent2.id, CALLBACK)).toHaveLength(0); // guard held
    // Parent reaches terminal (its own flow finishes) → guard cleared, callback fires.
    await executeAppRun(db, parent2.id, d);
    expect(await callbackRuns(parent2.id, CALLBACK)).toHaveLength(1);
  });
});

describe('appRuns(parentRunId:) — the run-tree filter (#548)', () => {
  it('returns exactly one fan-out\'s children (+ its coordination runs), org-scoped', async () => {
    const { resolvers } = await import('../api/graphql/schema/resolvers.js');
    const admin = await db.user.create({
      data: { githubId: 5548, githubUsername: 'spawn-admin', roles: ['READER'] },
    });
    await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
    const ctx = { db, userId: admin.id, roles: ['READER'] } as never;

    const parentA = await mintParent();
    await spawn3(parentA, { callback: CALLBACK });
    const parentB = await mintParent();
    await spawn3(parentB);
    for (const k of await children(parentA.id)) await executeAppRun(db, k.id, deps());

    const page = (await resolvers.Query.appRuns(
      {},
      { appRef: appId, parentRunId: parentA.id },
      ctx,
    )) as { items: Array<{ parentRunId: string | null }>; total: number };
    expect(page.total).toBe(4); // 3 children + the callback run
    expect(page.items.every((r) => r.parentRunId === parentA.id)).toBe(true);
  });
});

describe('hadron_child_runs (D-SP-6)', () => {
  it('lists children with outcomes, excludes coordination runs, defaults to own parent', async () => {
    const parent = await mintParent();
    await spawn3(parent, { callback: CALLBACK });
    const kids = await children(parent.id);
    const d = deps();
    for (const k of kids) await executeAppRun(db, k.id, d);

    // From the callback run's perspective: zero args.
    const cb = (await callbackRuns(parent.id, CALLBACK))[0];
    const listed = (await hadronChildRuns.execute(toolCtx(cb as AppRun), {})) as Array<{ id: string; status: string }>;
    expect(listed).toHaveLength(3); // the callback itself is not in the list
    expect(listed.every((c) => c.status === 'COMPLETED')).toBe(true);
  });

  it('is same-app scoped: a foreign fan-out is invisible', async () => {
    const parent = await mintParent();
    await spawn3(parent);
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: orgId, name: 'other', urn: 'spawn-org::other-app' },
    });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId } });
    const foreign = await mintAppRun(db, {
      organizationId: orgId, appId: otherApp.id, agentId, triggerKind: 'MANUAL', entryNodeUrn: ENTRY,
    });
    await expect(
      hadronChildRuns.execute(toolCtx(foreign as AppRun), { parentRunId: parent.id }),
    ).rejects.toThrow(/not found for this App/);
  });
});
