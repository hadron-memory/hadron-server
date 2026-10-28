/** #2048 S11b: current warnings about the inputs of ONE recorded compile revision, never expanded text/live edges. */
import { GraphQLError } from 'graphql';
import { memoryAccessFilter, type Context } from '../api/graphql/schema/resolvers.helpers.js';
import { assertMayWriteBootPromptPointer, loadBootPromptPointerOwner } from './bootPromptPointer.js';
import { readCompiledRevision, type CompiledTarget } from './bootCompile/provenance.js';
import { IncludeReadMemo, selectIncludeRevision } from './includes/spliceIncludes.js';
import { newestApprovedRevisionOf } from './nodeApproval.js';
import { safeNodeUrnV2 } from './urnEmit.js';
import { pageLintWarnings, type LintWarning, type LintWarningPage } from './bootPromptLint.js';

const MAX_OCCURRENCES = 10_000;
const BATCH = 100;
const warning = (kind: LintWarning['kind'], position: number, text: string, extra: Partial<LintWarning> = {}): LintWarning => ({
  kind, position, text, targetUrn: null, pinnedRevision: null, newerRevision: null, overriddenNodeLoc: null, workerField: null, ...extra,
});
async function mayCompile(ctx: Context, target: CompiledTarget): Promise<boolean> {
  const owner = await loadBootPromptPointerOwner(ctx.db, target.kind === 'AGENT'
    ? { field: 'AGENT', agentId: target.agentId }
    : target.kind === 'APP_AGENT' ? { field: 'APP_AGENT', appId: target.appId, agentId: target.agentId }
      : { field: 'WORKER', workerId: target.workerId });
  if (!owner) return false;
  try { await assertMayWriteBootPromptPointer(ctx, owner); return true; }
  catch (e) {
    if (e instanceof GraphQLError && ['FORBIDDEN', 'BOOT_PROMPT_POINTER_SESSION_REFUSED'].includes(String(e.extensions.code))) return false;
    throw e;
  }
}

/** Null is unavailable, including corrupt/missing provenance. No fault may fail an already committed write. */
export async function lintCompiledRevision(
  ctx: Context, nodeId: string, revNo: number, args: { first?: number | null; after?: string | null } = {},
): Promise<LintWarningPage | null> {
  try {
    const compiled = await ctx.db.node.findFirst({ where: { id: nodeId, deletedAt: null, memory: { deletedAt: null } }, select: { id: true } });
    if (!compiled) return null;
    const access = await memoryAccessFilter(ctx);
    const readable = await ctx.db.node.count({ where: { AND: [access, { id: nodeId }] } }) > 0;
    const revision = await readCompiledRevision(ctx.db, nodeId, revNo);
    if (!revision) return null;
    const manager = await mayCompile(ctx, revision.target);
    if (!readable && !manager) return null;
    const occurrences = revision.provenance.occurrences;
    if (occurrences.length > MAX_OCCURRENCES) throw new Error('Compiled lint occurrence limit exceeded');
    const ids = [...new Set(occurrences.flatMap(o => [o.nodeId, ...(o.replacesNodeId ? [o.replacesNodeId] : [])]))];
    const select = { id: true, memoryId: true, loc: true, content: true, revSeq: true, deletedAt: true,
      memory: { select: { id: true, urn: true, isEncrypted: true, isInstallMemory: true, appId: true } } } as const;
    type Row = Awaited<ReturnType<typeof ctx.db.node.findMany<{ select: typeof select }>>>[number];
    const visible = new Map<string, Row>(), selectable = new Map<string, Row>();
    for (let i = 0; i < ids.length; i += BATCH) {
      // Assembly rejects encrypted memories even with a key (assemble.ts, 6258629173); lint uses that same admissibility.
      const where = { id: { in: ids.slice(i, i + BATCH) }, memory: { deletedAt: null, isEncrypted: false } };
      // The manager's exception computes ONLY a generic availability bit; no hidden identity, position or count escapes.
      const rows = await ctx.db.node.findMany({ where: manager ? where : { AND: [access, where] }, select });
      for (const row of rows) selectable.set(row.id, row);
      if (readable) {
        const allowed = manager ? await ctx.db.node.findMany({ where: { AND: [access, where] }, select }) : rows;
        for (const row of allowed) visible.set(row.id, row);
      }
    }
    const memo = new IncludeReadMemo();
    const selections = new Map<string, Promise<{ revNo: number; text: string } | null>>();
    const newest = new Map<string, Promise<number | null>>();
    const warnings: LintWarning[] = [];
    let recompile = false;
    for (const occurrence of occurrences) {
      const row = selectable.get(occurrence.nodeId);
      const shown = visible.get(occurrence.nodeId);
      const position = occurrence.order; // immutable occurrence ordinal, independent of current source text
      const settings = { ...(occurrence.selection.rev === null ? {} : { rev: occurrence.selection.rev }), approved: occurrence.selection.approved, signed: occurrence.selection.signed };
      const urn = shown ? safeNodeUrnV2(shown.memory.urn, shown.loc) : null;
      if (readable && !shown) warnings.push(warning('BROKEN_INCLUDE', position, 'This include cannot be resolved.'));
      else if (readable && shown?.deletedAt) warnings.push(warning('RETIRED_TARGET', position, `Include target ${urn} is retired (deleted).`, { targetUrn: urn }));
      if (row && !row.deletedAt) {
        const key = `${row.id}:${settings.rev ?? ''}:${settings.approved}:${settings.signed}`;
        let selected = selections.get(key);
        if (!selected) {
          selected = selectIncludeRevision(ctx.db, memo, { ...row, memory: { id: row.memoryId, isEncrypted: false } }, settings);
          selections.set(key, selected);
        }
        const current = await selected;
        if (manager && current && current.revNo > occurrence.revNo) recompile = true;
        if (readable && shown && !current) warnings.push(warning('NO_QUALIFYING_REVISION', position,
          `Include target ${urn} has no revision that meets this include's settings.`, { targetUrn: urn, pinnedRevision: settings.rev ?? null }));
        if (readable && shown && settings.rev !== undefined) {
          let latest = newest.get(row.id);
          if (!latest) { latest = newestApprovedRevisionOf(ctx.db, row.id).then(r => r.found?.revNo ?? null); newest.set(row.id, latest); }
          const n = await latest;
          if (n !== null && n > settings.rev) warnings.push(warning('PINNED_NEWER_APPROVED', position,
            `Include pins revision ${settings.rev} of ${urn}; revision ${n} is approved and newer.`, { targetUrn: urn, pinnedRevision: settings.rev, newerRevision: n }));
        }
      }
      if (readable && shown && occurrence.kind === 'replacement' && revision.target.kind !== 'AGENT' &&
          shown.memory.isInstallMemory && shown.memory.appId === revision.target.appId) {
        const replaced = occurrence.replacesNodeId ? visible.get(occurrence.replacesNodeId) : null;
        warnings.push(warning('POLICY_OVERRIDE', position, replaced ? `This App overrides Agent node ${replaced.loc}.` : 'This App overrides an Agent node.',
          { targetUrn: urn, overriddenNodeLoc: replaced?.loc ?? null }));
      }
      if (readable && shown && settings.signed) warnings.push(warning('SIGNING_NOT_CHECKED', position,
        'The "signed" setting is not checked yet: signing has not shipped, so this include is served as if it were not signed.', { targetUrn: urn }));
    }
    if (recompile) warnings.push(warning('RECOMPILE_AVAILABLE', 0, 'A source part has a newer revision; recompile available.'));
    warnings.sort((a, b) => a.position - b.position || a.kind.localeCompare(b.kind));
    return pageLintWarnings(warnings, args);
  } catch (e) {
    console.error('[bootPromptLint] compiled warnings unavailable:', e instanceof Error ? e.message : e);
    return null;
  }
}
