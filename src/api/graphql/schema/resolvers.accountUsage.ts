// #3820 — Query.accountUsageProjection: the token-burn projection per account, with what-if (add a worker, move a worker).
//
// AUTHORIZATION: exactly the roster's (cor:agt:050:21): `withRosterReadGate` is the one function teamRoster uses, so a
// caller who cannot read the roster gets the roster's App-not-found refusal byte for byte. No write path and no host-key
// reach (cor:agt:070:04): the history is the `account-usage` objects an ordinary session already wrote into the team
// App's own shared memory (`loadAccountUsageHistory`). ADVISORY ONLY (Vera V15): nothing here authorizes, refuses or moves.
import type { GraphQLError } from 'graphql';
import { type Context } from './resolvers.helpers.js';
import { taskError } from './resolvers.agentTask.js';
import { withRosterReadGate } from './resolvers.agentTaskMatching.js';
import { loadAccountUsageHistory } from '../../../lib/accountUsage/load.js';
import {
  addBurn, projectAccount, withWorkerCount, WINDOW_KINDS,
  type UsageSnapshot, type WindowBasis, type WindowKind,
} from '../../../lib/accountUsage/projection.js';

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);

/** An account label is at most 64 characters (the collector's own bound); anything longer cannot name one. */
const MAX_LABEL = 64;
/** One call may add at most this many workers: a what-if, not a plan for a fleet. */
const MAX_ADD_WORKERS = 50;

type WhatIfInput = { addWorkers?: number | null; moveWorker?: { worker: string; toAccount: string } | null };

const newest = (history: readonly UsageSnapshot[]): UsageSnapshot | null =>
  history.reduce<UsageSnapshot | null>((best, s) => (best === null || s.observedAt > best.observedAt ? s : best), null);

const windows = (b: Record<WindowKind, WindowBasis>) => WINDOW_KINDS.map((k) => b[k].projection);

function parseWhatIf(raw: WhatIfInput | null | undefined, account: string): WhatIfInput | null {
  if (!raw) return null;
  const add = raw.addWorkers ?? null;
  const move = raw.moveWorker ?? null;
  if ((add === null) === (move === null)) throw badInput('whatIf takes exactly one of addWorkers and moveWorker.');
  if (add !== null && (!Number.isInteger(add) || add < 1 || add > MAX_ADD_WORKERS)) {
    throw badInput(`addWorkers must be a whole number from 1 to ${MAX_ADD_WORKERS}.`);
  }
  if (move) {
    if (move.worker.trim() === '' || move.toAccount.length === 0 || move.toAccount.length > MAX_LABEL) {
      throw badInput('moveWorker needs a worker name and a target account.');
    }
    if (move.toAccount === account) throw badInput('moveWorker must name a different account than the one projected.');
  }
  return { addWorkers: add, moveWorker: move };
}

export const accountUsageQueries = {
  accountUsageProjection: async (
    _: unknown,
    { appRef, account, whatIf }: { appRef: string; account: string; whatIf?: WhatIfInput | null },
    ctx: Context,
  ) =>
    withRosterReadGate(ctx, appRef, async (c, app) => {
      // Judged only after the gate, so a caller outside the App learns nothing from a malformed argument either.
      if (account.length === 0 || account.length > MAX_LABEL) throw badInput('account must be an account label of 1 to 64 characters.');
      const what = parseWhatIf(whatIf, account);
      const asOf = new Date();
      const history = await loadAccountUsageHistory(c.db, app.id, asOf);
      const mine = history.get(account) ?? [];
      const base = projectAccount(mine, asOf);
      const latest = newest(mine);
      const result: Record<string, unknown> = {
        account,
        family: latest?.family ?? null,
        asOf,
        newestSnapshotAt: latest?.observedAt ?? null,
        workers: latest?.workers ?? [],
        workersConfigured: latest?.workersConfigured ?? false,
        windows: windows(base),
        whatIf: null,
      };
      if (!what) return result;

      if (what.addWorkers != null) {
        const n = what.addWorkers;
        const current = latest && latest.workersConfigured ? latest.workers.length : 0;
        result.whatIf = {
          adjusted: WINDOW_KINDS.map((k) => withWorkerCount(base[k], current + n).projection),
          target: null,
        };
        return result;
      }

      const move = what.moveWorker!;
      const to = history.get(move.toAccount) ?? [];
      const toBase = projectAccount(to, asOf);
      // A worker the account does not list cannot be moved. Judged only when the account has history, so an unknown
      // account and an empty one answer alike (UNKNOWN), never a different refusal.
      if (latest && latest.workersConfigured && !latest.workers.includes(move.worker)) {
        throw badInput('The worker is not configured on that account.');
      }
      const from = latest && latest.workersConfigured ? latest.workers.length : 0;
      const adjustedSource = WINDOW_KINDS.map((k) => withWorkerCount(base[k], from - 1).projection);
      const adjustedTarget = WINDOW_KINDS.map((k) => addBurn(toBase[k], base[k].projection.perWorkerBurn).projection);
      result.whatIf = {
        adjusted: adjustedSource,
        target: { account: move.toAccount, baseline: windows(toBase), adjusted: adjustedTarget },
      };
      return result;
    }),
};
