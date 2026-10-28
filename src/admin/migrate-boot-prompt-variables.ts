/**
 * #2704 (S14 of #1772, ruling B7) — the audit and the migration of the legacy `{{name}}` / `{{role}}` boot-prompt
 * tokens to `{{worker.name}}` / `{{worker.role}}`, run by an operator from a host shell.
 *
 * AUDIT (read-only, `auditBootPromptTokens`): every live prompt text that holds a legacy token, or any token outside
 * the closed set (cor:dmo:150:08): `Agent.systemPrompt`, `Worker.promptOverride`, the boot-prompt source nodes and the
 * compiled nodes. It reports ids and counts only, never prompt text and never the text of a token.
 *
 * MIGRATE (`migrateBootPromptVariables`, dry-run by default): for each converted source (#2676: an Agent's
 * `boot:source`, a worker's `boot:workers:<id>:source`) that holds a legacy token, or whose SERVED compiled text (its
 * approved revision) does, the run rewrites the source, approves it, recompiles it in place, and approves the compiled revision, as the
 * same operator principal the conversion uses. The compiled text must equal the text SERVED today (the compiled node's
 * approved revision) with the legacy tokens renamed, byte for byte, or the row FAILS with the compiled node's approved
 * revision untouched (serving reads the approved revision, so a failed row changes nothing a worker sees).
 *
 * The rename changes no rendered text: every path already binds legacy `{{role}}` to the same value as `{{worker.role}}`
 * (the worker's own role, else the persona role) and `{{name}}` to `{{worker.name}}` (cor:dmo:150:08). Compiled text served
 * today leaves a legacy token literal (#2702), so the migrated text is the first one that binds.
 *
 * Idempotent: a source with no legacy token whose compiled node has none is not selected. A source already migrated by
 * an earlier run that stopped before the compile is picked up by its compiled node still holding a token.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { GraphQLError } from 'graphql';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../lib/bootPrompt.js';
import { readRecordedRevisionContent } from '../lib/bootPrompt/serve.js';
import { createOperatorConversionContext, OPERATOR_CONVERSION_INFO } from '../lib/auth/operatorConversion.js';
import { approveNodeInTransaction, NodeApprovalRefusal } from '../lib/nodeApproval.js';
import { PLATFORM_VARIABLE_KEYS } from '../lib/personaDescription.js';
import { compileBootPrompt } from '../api/graphql/schema/compileBootPrompt.js';
import { writeNodeCore } from '../api/graphql/schema/resolvers.mutation.node.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { AGENT_SOURCE_LOC } from './convert-boot-prompts.js';

const TOKEN = /\{\{([^{}]*)\}\}/g;
const LEGACY = /\{\{(name|role)\}\}/g;
const WORKER_SOURCE_LOC = /^boot:workers:([^:]+):source$/;
const CLOSED_SET: ReadonlySet<string> = new Set(PLATFORM_VARIABLE_KEYS);
const hasText = (s: string | null | undefined): s is string => typeof s === 'string' && s.length > 0;

/** The rename the migration makes, and the only edit it makes. */
export const renameLegacyTokens = (text: string): string => text.replace(LEGACY, (_m, key: string) => `{{worker.${key}}}`);

export type TokenSurface = 'AGENT_SYSTEM_PROMPT' | 'WORKER_PROMPT_OVERRIDE' | 'SOURCE_NODE' | 'COMPILED_NODE';
export interface TokenAuditRow {
  surface: TokenSurface;
  id: string;
  /** How many legacy `{{name}}` / `{{role}}` tokens the text holds. */
  legacy: number;
  /** How many tokens outside the closed set it holds (an include tag `{{> …}}` is not a variable). */
  unknown: number;
  /** For a column surface: whether the owner is served through a boot-prompt pointer, so the column is not read. */
  pointerSet?: boolean;
}
export interface TokenAuditReport {
  rows: TokenAuditRow[];
  /** Rows holding a legacy token, by surface; a column whose owner has a pointer set is counted apart (it is not served). */
  legacyBySurface: Record<TokenSurface, number>;
  retiredColumnLegacy: number;
  unknownBySurface: Record<TokenSurface, number>;
  /** True when no live, SERVED text holds a legacy token: the legacy binding may then be deleted (step 3). */
  legacyBindingRemovable: boolean;
}

function scan(text: string): { legacy: number; unknown: number } {
  let legacy = 0;
  let unknown = 0;
  for (const m of text.matchAll(TOKEN)) {
    const body = m[1];
    if (body.trimStart().startsWith('>')) continue;
    if (body === 'name' || body === 'role') legacy++;
    else if (!CLOSED_SET.has(body)) unknown++;
  }
  return { legacy, unknown };
}

/** Read-only. Ids and counts only. */
export async function auditBootPromptTokens(db: PrismaClient): Promise<TokenAuditReport> {
  const rows: TokenAuditRow[] = [];
  const push = (surface: TokenSurface, id: string, text: string | null, pointerSet?: boolean) => {
    if (!hasText(text)) return;
    const s = scan(text);
    if (s.legacy || s.unknown) rows.push({ surface, id, ...s, ...(pointerSet === undefined ? {} : { pointerSet }) });
  };
  for (const a of await db.agent.findMany({ where: { deletedAt: null, systemPrompt: { not: null } }, select: { id: true, systemPrompt: true, bootPromptNodeId: true }, orderBy: { id: 'asc' } })) {
    push('AGENT_SYSTEM_PROMPT', a.id, a.systemPrompt, a.bootPromptNodeId !== null);
  }
  for (const w of await db.worker.findMany({
    where: { promptOverride: { not: null }, retiredAt: null, app: { deletedAt: null, uninstalledAt: null } },
    select: { id: true, promptOverride: true, bootPromptNodeId: true }, orderBy: { id: 'asc' },
  })) push('WORKER_PROMPT_OVERRIDE', w.id, w.promptOverride, w.bootPromptNodeId !== null);
  for (const n of await db.node.findMany({ where: { role: 'boot-prompt', deletedAt: null }, select: { id: true, content: true, nodeType: true }, orderBy: { id: 'asc' } })) {
    if (n.nodeType !== COMPILED_BOOT_PROMPT_NODE_TYPE) { push('SOURCE_NODE', n.id, n.content); continue; }
    // Serving reads the approved revision, which can still hold a legacy token after a failed apply left newer
    // renamed text unapproved: scan both, as one row, so the binder is never declared removable while either holds one.
    const served = (await servedText(db, n.id))?.text;
    push('COMPILED_NODE', n.id, hasText(served) && served !== n.content ? `${n.content ?? ''}\n${served}` : n.content);
  }
  const zero = (): Record<TokenSurface, number> => ({ AGENT_SYSTEM_PROMPT: 0, WORKER_PROMPT_OVERRIDE: 0, SOURCE_NODE: 0, COMPILED_NODE: 0 });
  const legacyBySurface = zero();
  const unknownBySurface = zero();
  let retiredColumnLegacy = 0;
  for (const r of rows) {
    if (r.unknown) unknownBySurface[r.surface]++;
    if (!r.legacy) continue;
    if (r.pointerSet) retiredColumnLegacy++;
    else legacyBySurface[r.surface]++;
  }
  return {
    rows, legacyBySurface, retiredColumnLegacy, unknownBySurface,
    legacyBindingRemovable: Object.values(legacyBySurface).every((n) => n === 0),
  };
}

/** `candidate` is a dry-run row that still holds a legacy token and passed every check a read-only run can make; it is NOT a promise that apply succeeds. */
export type MigrationOutcome = 'migrated' | 'candidate' | 'skipped' | 'failed';
export interface MigrationRow {
  kind: 'AGENT' | 'WORKER';
  id: string;
  outcome: MigrationOutcome;
  /** Why a row was skipped or failed (a fixed phrase or a refusal code); never prompt text. */
  reason?: string;
}
export interface MigrationReport {
  applied: boolean;
  migrated: number;
  /** Dry run only: rows an apply would try (see `candidate`). */
  candidates: number;
  skipped: number;
  failed: number;
  rows: MigrationRow[];
}

class RowFailure extends Error {}

function reasonOf(e: unknown): string {
  if (e instanceof RowFailure) return e.message;
  if (e instanceof NodeApprovalRefusal) return e.code;
  if (e instanceof GraphQLError) return String(e.extensions?.code ?? 'GRAPHQL_ERROR');
  return 'UNEXPECTED_ERROR';
}

interface SourceRow { id: string; memoryId: string; loc: string; content: string | null; revSeq: number; approvedRevNo: number | null }

/** The text a worker is served from this compiled node today: its approved revision. */
async function servedText(db: PrismaClient, nodeId: string): Promise<{ text: string; approved: boolean; current: string } | null> {
  const node = await db.node.findFirst({ where: { id: nodeId, deletedAt: null }, select: { content: true, revSeq: true, approvedRevNo: true, nodeType: true } });
  if (!node || node.nodeType !== COMPILED_BOOT_PROMPT_NODE_TYPE) return null;
  if (node.approvedRevNo === null) return null;
  const text = await readRecordedRevisionContent(db, nodeId, node.approvedRevNo);
  return text === null ? null : { text, approved: node.approvedRevNo === node.revSeq, current: node.content ?? '' };
}

/**
 * Approve exactly the revision whose text was checked. Locks the node row, refuses when its text is no longer the
 * text that was validated (a concurrent edit between the check and the approval), and approves in the same
 * transaction, so an unchecked revision is never approved.
 */
export async function approveCheckedRevision(db: PrismaClient, nodeId: string, checkedContent: string): Promise<void> {
  const node = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { memoryId: true } });
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${nodeId} FOR UPDATE`;
    const live = await tx.node.findUniqueOrThrow({ where: { id: nodeId }, select: { content: true } });
    if (live.content !== checkedContent) throw new RowFailure('CHANGED_BEFORE_APPROVAL');
    await approveNodeInTransaction(tx, nodeId, {
      memoryId: node.memoryId,
      approver: { userId: null, info: OPERATOR_CONVERSION_INFO },
      key: null,
      bootPromptGate: { placed: false },
    });
  });
}

async function migrateSource(
  ctx: Context,
  p: { kind: 'AGENT' | 'WORKER'; ownerId: string; source: SourceRow; compiledNodeId: string; compile: Parameters<typeof compileBootPrompt>[1] },
  apply: boolean,
): Promise<MigrationRow> {
  const db = ctx.db as PrismaClient;
  const row = (outcome: MigrationOutcome, reason?: string): MigrationRow => ({ kind: p.kind, id: p.ownerId, outcome, ...(reason ? { reason } : {}) });
  try {
    const served = await servedText(db, p.compiledNodeId);
    if (!served) throw new RowFailure('COMPILED_NOT_APPROVED');
    const expected = renameLegacyTokens(served.text);
    const wanted = renameLegacyTokens(p.source.content ?? '');
    if (!apply) {
      // Read-only: an Agent source with no include tag compiles to its own text, so a source that no longer
      // matches the served text renamed is a row apply would refuse. Anything else cannot be judged without
      // writing, and is only a candidate.
      if (p.kind === 'AGENT' && !p.source.content?.includes('{{>') && wanted !== expected) throw new RowFailure('COMPILED_TEXT_DIFFERS');
      return row('candidate');
    }
    let source = p.source;
    if (source.content !== wanted) {
      await writeNodeCore({ memoryId: source.memoryId, loc: source.loc, content: wanted }, ctx, 'update', { targetNodeId: source.id });
      const fresh = await db.node.findUniqueOrThrow({ where: { id: source.id }, select: { id: true, memoryId: true, loc: true, content: true, revSeq: true, approvedRevNo: true } });
      if (fresh.content !== wanted) throw new RowFailure('SOURCE_TEXT_CHANGED_ON_WRITE');
      source = fresh;
    }
    if (source.approvedRevNo !== source.revSeq) await approveCheckedRevision(db, source.id, wanted);
    const compiled = await compileBootPrompt(ctx, p.compile, { setPointer: false });
    if (compiled.node.id !== p.compiledNodeId) throw new RowFailure('COMPILED_NODE_CHANGED');
    if (compiled.node.content !== expected) throw new RowFailure('COMPILED_TEXT_DIFFERS');
    await approveCheckedRevision(db, compiled.node.id, expected);
    return row('migrated');
  } catch (e) {
    return row('failed', reasonOf(e));
  }
}

/**
 * Run the migration. Agent sources first (a worker's source includes its Agent's), then worker sources. A failed row
 * never stops the run. `apply` false previews: writes nothing; rows it would try are reported as `candidate` (not a promise that apply succeeds), and an Agent row whose source drifted from the served text fails as apply would.
 */
export async function migrateBootPromptVariables(db: PrismaClient, opts: { apply?: boolean } = {}): Promise<MigrationReport> {
  const apply = opts.apply === true;
  const ctx = createOperatorConversionContext(db);
  const rows: MigrationRow[] = [];
  const select = { id: true, memoryId: true, loc: true, content: true, revSeq: true, approvedRevNo: true } as const;
  const holdsLegacy = (t: string | null | undefined) => hasText(t) && scan(t).legacy > 0;

  const agents = await db.agent.findMany({
    where: { deletedAt: null, bootPromptNodeId: { not: null } },
    select: { id: true, systemMemoryId: true, bootPromptNodeId: true }, orderBy: { id: 'asc' },
  });
  for (const agent of agents) {
    const source = agent.systemMemoryId
      ? await db.node.findFirst({ where: { memoryId: agent.systemMemoryId, loc: AGENT_SOURCE_LOC, role: 'boot-prompt', deletedAt: null }, select })
      : null;
    if (!source) {
      if (holdsLegacy((await servedText(db, agent.bootPromptNodeId!))?.text)) rows.push({ kind: 'AGENT', id: agent.id, outcome: 'failed', reason: 'SOURCE_MISSING' });
      continue;
    }
    if (!holdsLegacy(source.content) && !holdsLegacy((await servedText(db, agent.bootPromptNodeId!))?.text)) continue;
    const r = await migrateSource(ctx, { kind: 'AGENT', ownerId: agent.id, source, compiledNodeId: agent.bootPromptNodeId!, compile: { kind: 'AGENT', agentId: agent.id } }, apply);
    rows.push(r);
  }

  const workers = await db.worker.findMany({
    where: { bootPromptNodeId: { not: null }, retiredAt: null, app: { deletedAt: null, uninstalledAt: null } },
    select: { id: true, bootPromptNodeId: true, appId: true, agentId: true }, orderBy: { id: 'asc' },
  });
  for (const worker of workers) {
    // The worker's source lives in its App's install memory of the Agent (#2676), never looked up by loc alone.
    const install = await db.memory.findFirst({ where: { appId: worker.appId, installOfAgentId: worker.agentId, isInstallMemory: true, deletedAt: null }, select: { id: true } });
    // A converted worker whose source cannot be found still has served text holding a legacy token: say so.
    const reportMissing = async (reason: string) => {
      if (holdsLegacy((await servedText(db, worker.bootPromptNodeId!))?.text)) rows.push({ kind: 'WORKER', id: worker.id, outcome: 'failed', reason });
    };
    if (!install) { await reportMissing('INSTALL_MEMORY_MISSING'); continue; }
    const source = await db.node.findFirst({ where: { memoryId: install.id, loc: `boot:workers:${worker.id}:source`, role: 'boot-prompt', deletedAt: null }, select });
    if (!source || !WORKER_SOURCE_LOC.test(source.loc)) { await reportMissing('SOURCE_MISSING'); continue; }
    if (!holdsLegacy(source.content) && !holdsLegacy((await servedText(db, worker.bootPromptNodeId!))?.text)) continue;
    const r = await migrateSource(ctx, { kind: 'WORKER', ownerId: worker.id, source, compiledNodeId: worker.bootPromptNodeId!, compile: { kind: 'WORKER', workerId: worker.id } }, apply);
    rows.push(r);
  }
  const count = (o: MigrationOutcome) => rows.filter((r) => r.outcome === o).length;
  return { applied: apply, migrated: count('migrated'), candidates: count('candidate'), skipped: count('skipped'), failed: count('failed'), rows };
}
