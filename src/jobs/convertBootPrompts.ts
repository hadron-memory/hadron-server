/**
 * #2676 (S13 of #1772) — the one-time, repeatable conversion of today's boot prompts to boot-prompt nodes, AS-IS.
 *
 * Holger ruled on 2026-10-28 that there is no cleanup: the text in `Agent.systemPrompt` and `Worker.promptOverride`
 * is converted unchanged and its effective text does not move. Serving through the pointers is S10 (#2047); this run
 * only fills them.
 *
 *  - Agent with a `systemPrompt`: a source `boot:source` in its system memory, approved, compiled (S9), the compiled
 *    node approved, `Agent.bootPromptRef` set.
 *  - Worker with a `promptOverride`: today the override is APPENDED to the Agent's prompt, while a worker pointer
 *    REPLACES it (B2), so the worker's source is `{{> <the Agent's boot:source>}}`, a blank line, then the override
 *    (just the override when the Agent has no prompt), in the App's install memory at
 *    `boot:workers:<id>:source`. Same steps, `Worker.bootPromptRef` set.
 *  - There is no AppAgent prompt column, so no AppAgent conversion exists to do; that pointer stays empty.
 *
 * It composes only existing doors, as ONE named user acting as themselves (`--as-user`): the `createNode`,
 * `approveNode`, `compile*BootPrompt` and `set*BootPrompt` mutations. So every gate, lock and refusal is the one a
 * manager meets; nothing here writes a node, an approval or a pointer by another route. The acting user is the
 * principal recorded as the approver and must manage what is converted (for the team's own Apps: an org OWNER or
 * ADMIN who also participates in the App, since an install memory's text is read only by its App's participants and
 * a platform role alone does not make one). Whatever that user may not do is a failed row, never a bypass; run it
 * once per principal whose Agents and Apps are to be converted.
 *
 * Effective text is checked, not trusted: after every compile the compiled text must equal what the old
 * composition produced (raw tokens, as the legacy `{{name}}` / `{{role}}` and platform variables stay as written),
 * or the row fails with nothing approved and no pointer set. A text the as-is rule cannot carry fails too, rather
 * than being edited: text holding an include tag (`{{> …}}`, which the compile would resolve), and an override
 * holding `{{name}}` / `{{role}}` (the override keeps those as written today, a combined text would bind them).
 *
 * Idempotent: a row whose pointer is already set is skipped; an existing source or compiled node is reused when it
 * already carries the right text and never overwritten; a re-run changes nothing. Preview by default.
 *
 * Hand-run: `pnpm tsx src/jobs/convertBootPrompts.ts --as-user <userId> [--apply]` (DATABASE_URL = the serve
 * credential; every write goes through the doors above).
 */
import { GraphQLError } from 'graphql';
import type { PrismaClient } from '../generated/prisma/index.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../lib/bootPrompt.js';
import { safeNodeUrnV2 } from '../lib/urnEmit.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';

export const AGENT_SOURCE_LOC = 'boot:source';
export const workerSourceLoc = (workerId: string): string => `boot:workers:${workerId}:source`;

export type ConversionOutcome = 'converted' | 'skipped' | 'failed';
export interface ConversionRow {
  kind: 'AGENT' | 'WORKER';
  id: string;
  name: string;
  outcome: ConversionOutcome;
  /** Why a row was skipped or failed (a fixed phrase or a refusal code); never prompt text. */
  reason?: string;
}
export interface ConversionReport {
  applied: boolean;
  converted: number;
  skipped: number;
  failed: number;
  rows: ConversionRow[];
}

/** A row refused with a reason the run can name: carries no prompt text. */
class RowFailure extends Error {}

const INCLUDE_TAG = /\{\{\s*>/;
const LEGACY_TOKEN = /\{\{(?:name|role)\}\}/;
const hasText = (s: string | null | undefined): s is string => typeof s === 'string' && s.length > 0;

type Mutations = {
  createNode(_: unknown, a: unknown, c: Context): Promise<{ id: string }>;
  approveNode(_: unknown, a: { nodeRef: string }, c: Context): Promise<unknown>;
  compileAgentBootPrompt(_: unknown, a: { agentRef: string; setPointer: boolean }, c: Context): Promise<{ node: { id: string; content: string | null } }>;
  compileWorkerBootPrompt(_: unknown, a: { workerRef: string; setPointer: boolean }, c: Context): Promise<{ node: { id: string; content: string | null } }>;
  setAgentBootPrompt(_: unknown, a: { agentRef: string; nodeRef: string }, c: Context): Promise<unknown>;
  setWorkerBootPrompt(_: unknown, a: { workerRef: string; nodeRef: string }, c: Context): Promise<unknown>;
};
const door = (): Mutations => resolvers.Mutation as unknown as Mutations;

function reasonOf(e: unknown): string {
  if (e instanceof RowFailure) return e.message;
  if (e instanceof GraphQLError) return String(e.extensions?.code ?? 'GRAPHQL_ERROR');
  return 'UNEXPECTED_ERROR';
}

/**
 * The acting principal: one named user, acting as themselves. The gates decide what that user may do: an Agent or App
 * they do not manage, and an install memory they cannot read (approving there needs the App's participants' read), is
 * a failed row. Run once per principal whose Agents and Apps are to be converted.
 */
async function actingContext(db: PrismaClient, userId: string): Promise<Context> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, roles: true } });
  if (!user) throw new Error(`convertBootPrompts: no user ${userId}.`);
  return { db, userId: user.id, roles: user.roles, clientId: `user:${user.id}` } as Context;
}

/**
 * A node at this address that the run may reuse: exactly the right text in a plain boot-prompt source. A different
 * node there is never overwritten.
 */
async function reusableNode(
  db: PrismaClient, where: { memoryId: string; loc: string }, text: string, compiled: boolean,
): Promise<{ id: string; approved: boolean } | null> {
  const row = await db.node.findFirst({
    where: { ...where, deletedAt: null },
    select: { id: true, content: true, role: true, nodeType: true, revSeq: true, approvedRevNo: true },
  });
  if (!row) return null;
  const isCompiled = row.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE;
  if (row.role !== 'boot-prompt' || isCompiled !== compiled || row.content !== text) {
    throw new RowFailure('ADDRESS_OCCUPIED');
  }
  return { id: row.id, approved: row.approvedRevNo === row.revSeq };
}

/** Write (or reuse) the source, approve it, compile it, check the compiled text, approve that. Returns the compiled node id. */
async function sourceCompileApprove(
  ctx: Context,
  p: {
    sourceMemoryId: string | null; sourceLoc: string; sourceText: string; expected: string;
    create: (text: string) => Promise<{ id: string }>;
    compile: () => Promise<{ node: { id: string; content: string | null } }>;
    compiledMemoryId: () => Promise<string | null>; compiledLoc: string;
  },
): Promise<string> {
  const db = ctx.db as PrismaClient;
  let src = p.sourceMemoryId ? await reusableNode(db, { memoryId: p.sourceMemoryId, loc: p.sourceLoc }, p.sourceText, false) : null;
  if (!src) {
    const created = await p.create(p.sourceText);
    const written = await db.node.findUniqueOrThrow({ where: { id: created.id }, select: { content: true } });
    if (written.content !== p.sourceText) throw new RowFailure('SOURCE_TEXT_CHANGED_ON_WRITE');
    src = { id: created.id, approved: false };
  }
  if (!src.approved) await door().approveNode(null, { nodeRef: src.id }, ctx);

  const compiledMemoryId = await p.compiledMemoryId();
  let compiledId: string | null = null;
  if (compiledMemoryId) {
    const reuse = await reusableNode(db, { memoryId: compiledMemoryId, loc: p.compiledLoc }, p.expected, true).catch((e) => {
      // A compiled node with other text is not an obstacle: the compile writes a new revision of it.
      if (e instanceof RowFailure) return null;
      throw e;
    });
    if (reuse?.approved) return reuse.id;
    compiledId = reuse?.id ?? null;
  }
  if (!compiledId) {
    const compiled = await p.compile();
    if (compiled.node.content !== p.expected) throw new RowFailure('COMPILED_TEXT_DIFFERS');
    compiledId = compiled.node.id;
  }
  await door().approveNode(null, { nodeRef: compiledId }, ctx);
  return compiledId;
}

async function convertAgent(
  ctx: Context,
  agent: { id: string; name: string; systemPrompt: string | null; systemMemoryId: string | null; bootPromptNodeId: string | null },
  apply: boolean,
): Promise<ConversionRow> {
  const row = (outcome: ConversionOutcome, reason?: string): ConversionRow => ({ kind: 'AGENT', id: agent.id, name: agent.name, outcome, ...(reason ? { reason } : {}) });
  const text = agent.systemPrompt;
  if (!hasText(text)) return row('skipped', 'NO_PROMPT_TEXT');
  if (agent.bootPromptNodeId) return row('skipped', 'POINTER_ALREADY_SET');
  try {
    if (!agent.systemMemoryId) throw new RowFailure('NO_SYSTEM_MEMORY');
    if (INCLUDE_TAG.test(text)) throw new RowFailure('TEXT_HAS_INCLUDE_TAG');
    if (!apply) return row('converted');
    const systemMemoryId = agent.systemMemoryId;
    const compiledId = await sourceCompileApprove(ctx, {
      sourceMemoryId: systemMemoryId, sourceLoc: AGENT_SOURCE_LOC, sourceText: text, expected: text,
      create: (content) => door().createNode(null, { input: { memoryId: systemMemoryId, loc: AGENT_SOURCE_LOC, name: 'Boot prompt', role: 'boot-prompt', content } }, ctx),
      compile: () => door().compileAgentBootPrompt(null, { agentRef: agent.id, setPointer: false }, ctx),
      compiledMemoryId: async () => systemMemoryId, compiledLoc: 'boot:compiled',
    });
    await door().setAgentBootPrompt(null, { agentRef: agent.id, nodeRef: compiledId }, ctx);
    return row('converted');
  } catch (e) {
    return row('failed', reasonOf(e));
  }
}

async function convertWorker(
  ctx: Context,
  worker: { id: string; name: string; promptOverride: string | null; bootPromptNodeId: string | null; retiredAt: Date | null; appId: string; agentId: string },
  apply: boolean,
): Promise<ConversionRow> {
  const db = ctx.db as PrismaClient;
  const row = (outcome: ConversionOutcome, reason?: string): ConversionRow => ({ kind: 'WORKER', id: worker.id, name: worker.name, outcome, ...(reason ? { reason } : {}) });
  const override = worker.promptOverride;
  if (!hasText(override)) return row('skipped', 'NO_PROMPT_TEXT');
  if (worker.bootPromptNodeId) return row('skipped', 'POINTER_ALREADY_SET');
  if (worker.retiredAt) return row('skipped', 'WORKER_RETIRED');
  try {
    if (INCLUDE_TAG.test(override)) throw new RowFailure('TEXT_HAS_INCLUDE_TAG');
    // The override keeps `{{name}}` / `{{role}}` as written today; inside one combined text they would be bound.
    if (LEGACY_TOKEN.test(override)) throw new RowFailure('OVERRIDE_HAS_LEGACY_TOKEN');
    const agent = await db.agent.findUnique({
      where: { id: worker.agentId },
      select: { id: true, systemPrompt: true, systemMemoryId: true, bootPromptNodeId: true, deletedAt: true },
    });
    if (!agent || agent.deletedAt) throw new RowFailure('AGENT_RETIRED');
    const agentText = hasText(agent.systemPrompt) ? agent.systemPrompt : null;
    let sourceText = override;
    let expected = override;
    if (agentText) {
      // The Agent's prompt is the first part of this worker's text: it must be a converted, approved boot prompt.
      // A preview has converted nothing yet, so it asks only whether this run would convert the Agent.
      const converted = agent.bootPromptNodeId !== null || (!apply && !INCLUDE_TAG.test(agentText));
      if (!agent.systemMemoryId || !converted) throw new RowFailure('AGENT_NOT_CONVERTED');
      const memory = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId }, select: { urn: true } });
      sourceText = `{{> ${safeNodeUrnV2(memory.urn, AGENT_SOURCE_LOC)}}}\n\n${override}`;
      expected = `${agentText}\n\n${override}`;
    }
    if (!apply) return row('converted');
    const install = { appRef: worker.appId, agentRef: worker.agentId };
    const installMemory = () => db.memory.findFirst({
      where: { class: 'system', isInstallMemory: true, appId: worker.appId, installOfAgentId: worker.agentId, deletedAt: null },
      select: { id: true },
    });
    const loc = workerSourceLoc(worker.id);
    const compiledId = await sourceCompileApprove(ctx, {
      sourceMemoryId: (await installMemory())?.id ?? null, sourceLoc: loc, sourceText, expected,
      create: (content) => door().createNode(null, { input: { install, loc, name: 'Boot prompt', role: 'boot-prompt', content } }, ctx),
      compile: () => door().compileWorkerBootPrompt(null, { workerRef: worker.id, setPointer: false }, ctx),
      compiledMemoryId: async () => (await installMemory())?.id ?? null, compiledLoc: `boot:workers:${worker.id}:compiled`,
    });
    await door().setWorkerBootPrompt(null, { workerRef: worker.id, nodeRef: compiledId }, ctx);
    return row('converted');
  } catch (e) {
    return row('failed', reasonOf(e));
  }
}

/**
 * Run the conversion. Agents first (a worker's source includes its Agent's), then workers. A failed row never stops
 * the run. `apply` false previews: it reports what would convert, writes nothing, and checks only what can be
 * checked without compiling.
 */
export async function convertBootPrompts(
  db: PrismaClient,
  opts: { actingUserId: string; apply?: boolean },
): Promise<ConversionReport> {
  const apply = opts.apply === true;
  const ctx = await actingContext(db, opts.actingUserId);
  const rows: ConversionRow[] = [];

  const agents = await db.agent.findMany({
    where: { deletedAt: null, systemPrompt: { not: null } },
    select: { id: true, name: true, systemPrompt: true, systemMemoryId: true, bootPromptNodeId: true },
    orderBy: { id: 'asc' },
  });
  for (const agent of agents) rows.push(await convertAgent(ctx, agent, apply));

  const workers = await db.worker.findMany({
    where: { promptOverride: { not: null }, app: { deletedAt: null, uninstalledAt: null } },
    select: { id: true, name: true, promptOverride: true, bootPromptNodeId: true, retiredAt: true, appId: true, agentId: true },
    orderBy: { id: 'asc' },
  });
  for (const worker of workers) rows.push(await convertWorker(ctx, worker, apply));

  const count = (o: ConversionOutcome) => rows.filter((r) => r.outcome === o).length;
  return { applied: apply, converted: count('converted'), skipped: count('skipped'), failed: count('failed'), rows };
}

// Hand-run entry point. No import side effects when this module is imported by tests.
if (process.argv[1] && /convertBootPrompts\.[tj]s$/.test(process.argv[1])) {
  // The extended client (id injection), as the server itself uses.
  const { db: client } = await import('../integrations/db/client.js');
  const args = process.argv.slice(2);
  const at = args.indexOf('--as-user');
  const apply = args.includes('--apply');
  if (at < 0 || !args[at + 1] || args.some((a, i) => a.startsWith('--') && !['--as-user', '--apply'].includes(a) && i !== at + 1)) {
    throw new Error('Usage: convertBootPrompts.ts --as-user <platform admin user id> [--apply]');
  }
  try {
    const report = await convertBootPrompts(client, { actingUserId: args[at + 1], apply });
    process.stdout.write(JSON.stringify({ ...report, rows: report.rows.filter((r) => r.outcome !== 'skipped' || r.reason !== 'NO_PROMPT_TEXT') }, null, 2) + '\n');
  } finally {
    await client.$disconnect();
  }
}
