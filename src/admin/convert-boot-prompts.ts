/**
 * #2676 (S13 of #1772, ruling P9) — the one-time, repeatable conversion of today's boot prompts to approved
 * boot-prompt nodes, AS-IS, run by an operator from a host shell.
 *
 * Holger ruled on 2026-10-28 that there is no cleanup: the text in `Agent.systemPrompt` and `Worker.promptOverride`
 * is converted unchanged. Serving through the pointers is S10; this run only fills them.
 *
 *  - Agent with a `systemPrompt`: the text, unchanged, as the source `boot:source` in its system memory; compiled
 *    (S9); the compiled revision approved; `Agent.bootPromptNodeId` set.
 *  - Worker with a `promptOverride`: today the override is APPENDED to the Agent's prompt, while a worker pointer
 *    REPLACES it (B2), so the worker's source is `{{> <the Agent's boot:source>}}`, a blank line, then the override
 *    (just the override when the Agent has no prompt), at `boot:workers:<id>:source` in the App's install memory
 *    (made on demand, S7). Same steps, `Worker.bootPromptNodeId` set. A worker without an override gets nothing.
 *  - Not converted: `App.systemPrompt` (deprecated) and AppAgent (no prompt column).
 *
 * No manager acts here. The run is ONE operator principal (`createOperatorConversionContext`, the seam in
 * `lib/auth/operatorConversion.ts`) calling the internal compile, node writer, approval and pointer functions
 * directly. The GraphQL mutations and their human-manager guard are not involved and unchanged. Approvals and
 * revisions carry the info string `OPERATOR_CONVERSION_INFO` (an operator conversion, P9), never a user id, in the
 * existing approval record. No new approval kind. The approval's boot-prompt gate is passed as `{ placed: false }`
 * on purpose: that gate asks whether a USER manages the memory, which no operator is.
 *
 * The comparison is built here. For every row the text before conversion (the Agent's template, then `\n\n` and the
 * override, exactly as `composeWorkerPrompt` joins them, before platform variables are bound and without the derived
 * register block) must equal the compiled node's text byte for byte, or the row FAILS with nothing approved and no
 * pointer set. The rows whose RENDERED text differs after conversion are listed with the reason: an override's
 * `{{name}}` / `{{role}}` stays literal today (the override is bound without the legacy args) and binds once the
 * compiled node is served (P9, accepted). Text holding an include tag (`{{> …}}`, which the compile would resolve)
 * fails rather than being edited.
 *
 * Idempotent: a row whose pointer is already set is skipped; an existing source or compiled node is reused when it
 * already carries the right text and never overwritten; a re-run changes nothing. Dry-run by default.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { GraphQLError } from 'graphql';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../lib/bootPrompt.js';
import { createOperatorConversionContext, OPERATOR_CONVERSION_INFO } from '../lib/auth/operatorConversion.js';
import { approveNodeInTransaction, NodeApprovalRefusal } from '../lib/nodeApproval.js';
import { loadBootPromptPointerOwner, setBootPromptPointer, type BootPromptPointerTarget } from '../lib/bootPromptPointer.js';
import { safeNodeUrnV2 } from '../lib/urnEmit.js';
import { compileBootPrompt, type CompileTargetInput } from '../api/graphql/schema/compileBootPrompt.js';
import { ensureInstallMemory } from '../api/graphql/schema/installMemory.js';
import { writeNodeCore } from '../api/graphql/schema/resolvers.mutation.node.js';
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
/** A converted row whose rendered text will differ from today's, with the reason (never prompt text). */
export interface RenderedDifference {
  kind: 'WORKER';
  id: string;
  name: string;
  reason: 'OVERRIDE_LEGACY_TOKEN_NOW_BINDS';
  tokens: string[];
}
export interface ConversionReport {
  applied: boolean;
  converted: number;
  skipped: number;
  failed: number;
  rows: ConversionRow[];
  renderedDifferences: RenderedDifference[];
}

/** A row refused with a reason the run can name: carries no prompt text. */
class RowFailure extends Error {}

const INCLUDE_TAG = /\{\{\s*>/;
const LEGACY_TOKENS = /\{\{(?:name|role)\}\}/g;
const hasText = (s: string | null | undefined): s is string => typeof s === 'string' && s.length > 0;

/** The text `composeWorkerPrompt` builds from the two authored texts, before variables are bound. */
export const authoredBootText = (agentTemplate: string | null, override: string | null): string | null =>
  hasText(agentTemplate) && hasText(override) ? `${agentTemplate}\n\n${override}` : (hasText(override) ? override : (hasText(agentTemplate) ? agentTemplate : null));

function reasonOf(e: unknown): string {
  if (e instanceof RowFailure) return e.message;
  if (e instanceof NodeApprovalRefusal) return e.code;
  if (e instanceof GraphQLError) return String(e.extensions?.code ?? 'GRAPHQL_ERROR');
  return 'UNEXPECTED_ERROR';
}

/**
 * A node at this address that the run may reuse: exactly the right text in a plain boot-prompt source (or a compiled
 * node). A different node there is never overwritten.
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

/** Approve the node's current revision as the operator conversion (the existing approval record, info only). */
async function approveAsOperator(db: PrismaClient, nodeId: string): Promise<void> {
  const node = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { memoryId: true } });
  await db.$transaction((tx) => approveNodeInTransaction(tx, nodeId, {
    memoryId: node.memoryId,
    approver: { userId: null, info: OPERATOR_CONVERSION_INFO },
    key: null,
    bootPromptGate: { placed: false },
  }));
}

async function setPointerAsOperator(ctx: Context, target: BootPromptPointerTarget, nodeId: string): Promise<void> {
  await (ctx.db as PrismaClient).$transaction(async (tx) => {
    const owner = await loadBootPromptPointerOwner(tx, target, { lockForWrite: true });
    if (!owner) throw new RowFailure('POINTER_OWNER_NOT_FOUND');
    await setBootPromptPointer(tx, ctx, owner, nodeId, async () => true);
  });
}

/** Write (or reuse) the source and approve it, compile it, check the compiled text, approve that. Returns the compiled node id. */
async function sourceCompileApprove(
  ctx: Context,
  p: {
    sourceMemoryId: string; sourceLoc: string; sourceText: string; expected: string;
    compile: CompileTargetInput; compiledLoc: string;
  },
): Promise<string> {
  const db = ctx.db as PrismaClient;
  let src = await reusableNode(db, { memoryId: p.sourceMemoryId, loc: p.sourceLoc }, p.sourceText, false);
  if (!src) {
    const written = await writeNodeCore(
      { memoryId: p.sourceMemoryId, loc: p.sourceLoc, name: 'Boot prompt', role: 'boot-prompt', content: p.sourceText },
      ctx, 'create',
    );
    const row = await db.node.findUniqueOrThrow({ where: { id: written.id }, select: { content: true } });
    if (row.content !== p.sourceText) throw new RowFailure('SOURCE_TEXT_CHANGED_ON_WRITE');
    src = { id: written.id, approved: false };
  }
  if (!src.approved) await approveAsOperator(db, src.id);

  const reuse = await reusableNode(db, { memoryId: p.sourceMemoryId, loc: p.compiledLoc }, p.expected, true)
    .catch((e) => {
      // A compiled node with other text is not an obstacle: the compile writes a new revision of it.
      if (e instanceof RowFailure) return null;
      throw e;
    });
  if (reuse?.approved) return reuse.id;
  let compiledId = reuse?.id ?? null;
  if (!compiledId) {
    const compiled = await compileBootPrompt(ctx, p.compile, { setPointer: false });
    if (compiled.node.content !== p.expected) throw new RowFailure('COMPILED_TEXT_DIFFERS');
    compiledId = compiled.node.id;
  }
  await approveAsOperator(db, compiledId);
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
    const compiledId = await sourceCompileApprove(ctx, {
      sourceMemoryId: agent.systemMemoryId, sourceLoc: AGENT_SOURCE_LOC, sourceText: text, expected: text,
      compile: { kind: 'AGENT', agentId: agent.id }, compiledLoc: 'boot:compiled',
    });
    await setPointerAsOperator(ctx, { field: 'AGENT', agentId: agent.id }, compiledId);
    return row('converted');
  } catch (e) {
    return row('failed', reasonOf(e));
  }
}

async function convertWorker(
  ctx: Context,
  worker: { id: string; name: string; promptOverride: string | null; bootPromptNodeId: string | null; retiredAt: Date | null; appId: string; agentId: string },
  apply: boolean,
  differences: RenderedDifference[],
): Promise<ConversionRow> {
  const db = ctx.db as PrismaClient;
  const row = (outcome: ConversionOutcome, reason?: string): ConversionRow => ({ kind: 'WORKER', id: worker.id, name: worker.name, outcome, ...(reason ? { reason } : {}) });
  const override = worker.promptOverride;
  if (!hasText(override)) return row('skipped', 'NO_PROMPT_TEXT');
  if (worker.bootPromptNodeId) return row('skipped', 'POINTER_ALREADY_SET');
  if (worker.retiredAt) return row('skipped', 'WORKER_RETIRED');
  try {
    if (INCLUDE_TAG.test(override)) throw new RowFailure('TEXT_HAS_INCLUDE_TAG');
    const agent = await db.agent.findUnique({
      where: { id: worker.agentId },
      select: { id: true, systemPrompt: true, systemMemoryId: true, bootPromptNodeId: true, deletedAt: true },
    });
    if (!agent || agent.deletedAt) throw new RowFailure('AGENT_RETIRED');
    const agentText = hasText(agent.systemPrompt) ? agent.systemPrompt : null;
    let sourceText = override;
    if (agentText) {
      // The Agent's prompt is the first part of this worker's text: it must be a converted boot prompt. A preview has
      // converted nothing yet, so it asks only whether this run would convert the Agent.
      const converted = agent.bootPromptNodeId !== null || (!apply && !INCLUDE_TAG.test(agentText));
      if (!agent.systemMemoryId || !converted) throw new RowFailure('AGENT_NOT_CONVERTED');
      const memory = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId }, select: { urn: true } });
      sourceText = `{{> ${safeNodeUrnV2(memory.urn, AGENT_SOURCE_LOC)}}}\n\n${override}`;
    }
    const expected = authoredBootText(agentText, override)!;
    // The one difference conversion makes to the rendered text, listed per row (P9).
    const tokens = [...new Set(override.match(LEGACY_TOKENS) ?? [])];
    if (!apply) {
      if (tokens.length) differences.push({ kind: 'WORKER', id: worker.id, name: worker.name, reason: 'OVERRIDE_LEGACY_TOKEN_NOW_BINDS', tokens });
      return row('converted');
    }
    // The install memory is made on demand (S7), in its own transaction under the operator principal.
    const installMemoryId = (await db.$transaction((tx) => ensureInstallMemory(tx, ctx, worker.appId, worker.agentId))).id;
    const compiledId = await sourceCompileApprove(ctx, {
      sourceMemoryId: installMemoryId, sourceLoc: workerSourceLoc(worker.id), sourceText, expected,
      compile: { kind: 'WORKER', workerId: worker.id }, compiledLoc: `boot:workers:${worker.id}:compiled`,
    });
    await setPointerAsOperator(ctx, { field: 'WORKER', workerId: worker.id }, compiledId);
    if (tokens.length) differences.push({ kind: 'WORKER', id: worker.id, name: worker.name, reason: 'OVERRIDE_LEGACY_TOKEN_NOW_BINDS', tokens });
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
export async function convertBootPrompts(db: PrismaClient, opts: { apply?: boolean } = {}): Promise<ConversionReport> {
  const apply = opts.apply === true;
  const ctx = createOperatorConversionContext(db);
  const rows: ConversionRow[] = [];
  const renderedDifferences: RenderedDifference[] = [];

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
  for (const worker of workers) rows.push(await convertWorker(ctx, worker, apply, renderedDifferences));

  const count = (o: ConversionOutcome) => rows.filter((r) => r.outcome === o).length;
  return { applied: apply, converted: count('converted'), skipped: count('skipped'), failed: count('failed'), rows, renderedDifferences };
}
