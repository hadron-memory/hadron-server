/** #2733: issue-time guidance, separate from wake identity, proof, scheduling and acknowledgement. */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isAppParticipant } from '../../api/graphql/schema/resolvers.helpers.js';
import { withoutRequestCaches } from '../../api/graphql/schema/resolvers.helpers.js';
import { liveTxContext } from '../../api/graphql/schema/authorizedTx.js';
import { boundedRead } from '../../api/graphql/schema/resolvers.taskWarnings.js';
import { RegisterData, RegisterLookup } from '../actionRegister/lookup.js';
import type { WorkerWake } from './wakeRule.js';

export type PublicTickAction = { code: string; state: 'MAPPED' | 'UNMAPPED' | 'UNRESOLVED' | 'WITHHELD'; taskLoc?: string; taskUrn?: string };
export type StoredTickAction = {
  code: string;
  state: 'MAPPED' | 'UNMAPPED' | 'UNRESOLVED' | 'UNKNOWN';
  taskLoc?: string;
  taskUrn?: string;
  entryMemoryIds?: string[];
  taskMemoryId?: string;
  /** Issue-time complete chains for per-read disclosure; never returned to the caller. */
  disclosureMemoryIds?: string[];
};
type Item = { workerId: string; wake: WorkerWake };
type App = { id: string; organizationId: string | null; ownerUserId: string | null };

export async function enrichTickWakes(ctx: Context, app: App, items: Item[], refresh: Set<string>, knownTickers: Map<string, { name: string; tickCode: string }> = new Map()): Promise<Map<string, { stored: WorkerWake; visible: WorkerWake; tickText: string | null }>> {
  const results = new Map<string, { stored: WorkerWake; visible: WorkerWake; tickText: string | null }>();
  const ids = [...new Set(items.flatMap(i => i.wake.reasons.flatMap(r => r.kind === 'TICK' ? [r.tickerId] : [])))];
  if (!ids.length) return results;
  // Install defaults first. A timeout or failure cannot change whether a worker is due.
  let names = new Map(knownTickers);
  const answers = new Map<string, StoredTickAction>();
  const visible = new Map<string, PublicTickAction>();
  const key = (worker: string, ticker: string) => worker + '\u0000' + ticker;
  try {
    await boundedRead(ctx, async (tx, deadline) => {
      const missing = ids.filter(id => !names.has(id));
      if (missing.length) for (const t of await tx.ticker.findMany({ where: { appId: app.id, id: { in: missing } }, select: { id: true, name: true, tickCode: true } })) names.set(t.id, t);
      const workers = new Map((await tx.worker.findMany({ where: { appId: app.id, id: { in: items.map(i => i.workerId) } }, select: { id: true, heldByUserId: true, agent: { select: { systemMemoryId: true, deletedAt: true } } } })).map(w => [w.id, w]));
      const txCtx = await liveTxContext(withoutRequestCaches(ctx, tx), tx);
      const lookups = new Map<string, RegisterLookup>();
      // #2950: one set of register rows for the whole read. Answers and readability stay per principal (one
      // lookup each); only the rows are shared, so a code's reads no longer repeat per holder or per chain link.
      const codes = new Set<string>();
      for (const item of items) for (const r of item.wake.reasons) if (r.kind === 'TICK') codes.add(names.get(r.tickerId)?.tickCode ?? r.action?.code ?? 'tick.unknown');
      const data = new RegisterData(tx, codes);
      const readerLookup = new RegisterLookup(tx, txCtx, app.id, deadline, false, undefined, data);
      const teamMemoryId = await readerLookup.teamMemory();
      const teamChain = teamMemoryId ? await readerLookup.chain(teamMemoryId) : [];
      const holders = new Map<string, Promise<Context | null>>();
      const holder = (id: string): Promise<Context | null> => {
        let found = holders.get(id);
        if (!found) {
          found = (async () => {
            const u = await tx.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, roles: true } });
            if (!u) return null;
            const auth = { db: tx, userId: u.id, roles: u.roles } as unknown as Context;
            return await isAppParticipant(auth, app) ? auth : null;
          })();
          holders.set(id, found);
        }
        return found;
      };
      for (const item of items) {
        const worker = workers.get(item.workerId);
        const auth = worker?.heldByUserId ? await holder(worker.heldByUserId) : txCtx;
        const principal = worker?.heldByUserId ?? 'unheld';
        let lookup = lookups.get(principal);
        if (!lookup && auth) { lookup = new RegisterLookup(tx, auth, app.id, deadline, !worker?.heldByUserId, teamMemoryId, data); lookups.set(principal, lookup); }
        for (const reason of item.wake.reasons) {
          if (reason.kind !== 'TICK') continue;
          readerLookup.checkDeadline();
          const code = names.get(reason.tickerId)?.tickCode ?? reason.action?.code ?? 'tick.unknown';
          const k = key(item.workerId, reason.tickerId);
          let answer: StoredTickAction = reason.action && 'entryMemoryIds' in reason.action
            ? reason.action as StoredTickAction : { code, state: 'UNKNOWN' };
          if (refresh.has(item.workerId)) {
            answer = { code, state: 'UNKNOWN' };
            if (!teamMemoryId) answer = { code, state: 'UNMAPPED', entryMemoryIds: [], disclosureMemoryIds: [] };
            else if (lookup) {
              const entry = await lookup.entry(code);
              if (entry.state === 'UNMAPPED') answer = { code, state: 'UNMAPPED', entryMemoryIds: entry.checkedMemoryIds, disclosureMemoryIds: teamChain };
              else if (entry.state === 'FOUND') {
                answer = { code, state: 'UNRESOLVED', taskLoc: entry.taskLoc, entryMemoryIds: entry.checkedMemoryIds, disclosureMemoryIds: teamChain };
                const memoryId = worker?.agent?.deletedAt ? null : worker?.agent?.systemMemoryId;
                if (memoryId) answer.disclosureMemoryIds = [...new Set([...teamChain, ...await readerLookup.chain(memoryId)])];
                const hit = memoryId ? await lookup.task(memoryId, entry.taskLoc) : null;
                if (hit) {
                  answer.taskMemoryId = hit.memoryId;
                  if (hit.task) answer = { ...answer, state: 'MAPPED', taskUrn: hit.task.urn };
                }
              }
            }
          }
          answers.set(k, answer);
          let disclose = answer.state !== 'UNKNOWN' && !!answer.disclosureMemoryIds && (!!auth || answer.state === 'UNMAPPED' && answer.entryMemoryIds?.length === 0);
          // R1 refinement requires complete chains, including empty and farther memories.
          // Gate the complete stored topology for the reader, while preserving worker-side resolution.
          for (const id of answer.disclosureMemoryIds ?? []) {
            if (!disclose) break;
            disclose = await readerLookup.readable(txCtx, id, 'reader');
          }
          for (const id of answer.entryMemoryIds ?? []) {
            if (!disclose) break;
            disclose = await readerLookup.readable(txCtx, id, 'reader') && await readerLookup.readable(auth!, id, principal);
          }
          // A worker-side unreadable nearest task is UNRESOLVED, not a farther task (acceptance 11).
          // This never relaxes the entry gate, even when entry and task share one memory.
          if (disclose && answer.taskMemoryId) disclose = await readerLookup.readable(txCtx, answer.taskMemoryId, 'reader') &&
            (answer.state === 'UNRESOLVED' || await readerLookup.readable(auth!, answer.taskMemoryId, principal));
          visible.set(k, disclose ? { code: answer.code, state: answer.state as PublicTickAction['state'], ...(answer.taskLoc ? { taskLoc: answer.taskLoc } : {}), ...(answer.taskUrn ? { taskUrn: answer.taskUrn } : {}) } : { code: answer.code, state: 'WITHHELD' });
        }
      }
    });
  } catch {
    // Roll back the whole enrichment, not the wake. Persist failure as UNKNOWN until a new tick joins.
    answers.clear(); visible.clear();
  }
  for (const item of items) {
    const stored: WorkerWake = { ...item.wake, reasons: item.wake.reasons.map(r => {
      if (r.kind !== 'TICK') return r;
      const code = names.get(r.tickerId)?.tickCode ?? r.action?.code ?? 'tick.unknown';
      const kept = !refresh.has(item.workerId) && r.action && 'entryMemoryIds' in r.action ? r.action as StoredTickAction : null;
      return { ...r, action: answers.get(key(item.workerId, r.tickerId)) ?? kept ?? { code, state: 'UNKNOWN' as const } };
    }) };
    const publicWake: WorkerWake = { ...item.wake, reasons: item.wake.reasons.map(r => {
      if (r.kind !== 'TICK') return r;
      const code = names.get(r.tickerId)?.tickCode ?? r.action?.code ?? 'tick.unknown';
      return { ...r, action: visible.get(key(item.workerId, r.tickerId)) ?? { code, state: 'WITHHELD' as const } };
    }) };
    results.set(item.workerId, { stored, visible: publicWake, tickText: renderTickText(publicWake, names) });
  }
  return results;
}

export function renderTickText(wake: WorkerWake, tickers: Map<string, { name: string }>): string | null {
  const seen = new Set<string>();
  const reasons = wake.reasons.filter(r => r.kind === 'TICK').sort((a, b) => {
    const an = tickers.get(a.tickerId)?.name ?? a.tickerId;
    const bn = tickers.get(b.tickerId)?.name ?? b.tickerId;
    return an < bn ? -1 : an > bn ? 1 : a.tickerId < b.tickerId ? -1 : a.tickerId > b.tickerId ? 1 : 0;
  });
  const lines = reasons.map(r => {
    const name = (tickers.get(r.tickerId)?.name ?? r.tickerId).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
    const a = r.action;
    const prefix = 'tick ' + name + ': ';
    if (a?.state === 'MAPPED' && a.taskUrn) {
      if (seen.has(a.taskUrn)) return prefix + 'same task as above';
      seen.add(a.taskUrn); return prefix + 'run ' + a.taskUrn;
    }
    if (a?.state === 'UNMAPPED') return prefix + 'no task is mapped for ' + a.code;
    if (a?.state === 'UNRESOLVED') return prefix + 'no task found at ' + a.taskLoc + ' for ' + a.code;
    return prefix + 'resolve your task for ' + (a?.code ?? 'tick.unknown') + ' yourself';
  });
  return lines.length ? lines.join(' · ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') : null;
}
