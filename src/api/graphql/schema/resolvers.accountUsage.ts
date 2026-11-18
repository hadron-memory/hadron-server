// #3820 — Query.accountUsageProjection: the token-burn projection per account, with what-if (add a worker, move a worker).
//
// AUTHORIZATION (cor:agt:140:03; Vera V27, V36): read as the team's tasks and events are read (cor:agt:050:21, :23): the App's
// participants and the App's own key, through `withReadableApp`, the function the task reads use. Anyone else is refused
// APP_NOT_FOUND, the answer for an App that does not exist, telling nothing about the account. No write path and no host-key
// reach (cor:agt:070:04): the history is the `account-usage` objects an ordinary session already wrote into the team App's own
// shared memory (`loadAccountUsageHistory`). ADVISORY ONLY (V15): nothing here authorizes, refuses or moves anything.
import type { GraphQLError } from 'graphql';
import { type Context } from './resolvers.helpers.js';
import { taskError, withReadableApp } from './resolvers.agentTask.js';
import { loadAccountUsageCensus } from '../../../lib/accountUsage/load.js';
import { listUsageAccounts } from '../../../lib/accountUsage/list.js';
import {
  addBurn, incompleteAccount, newestSnapshot, projectAccount, withWorkerCount, FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES,
  type UsageSnapshot, type WindowBasis, type WindowProjection,
} from '../../../lib/accountUsage/projection.js';

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);

/** An account label is at most 64 characters (the collector's own bound); anything longer cannot name one. */
const MAX_LABEL = 64;
/** One call may add at most this many workers: a what-if, not a plan for a fleet. */
const MAX_ADD_WORKERS = 50;

type MoveInput = { worker: string; toAccount: string; toHost?: string | null; toFamily?: string | null };
type WhatIfInput = { addWorkers?: number | null; moveWorker?: MoveInput | null };

const newest = newestSnapshot;

/** The GraphQL view of a window: the enum names the two standard lengths, OTHER any other, and `lengthMinutes` always. */
const view = (p: WindowProjection) => ({
  ...p,
  lengthMinutes: p.window,
  window: p.window === FIVE_HOUR_MINUTES ? 'FIVE_HOUR' : p.window === SEVEN_DAY_MINUTES ? 'SEVEN_DAY' : 'OTHER',
});
const views = (bases: readonly WindowBasis[]) => bases.map((b) => view(b.projection));

/**
 * One account's history: the snapshots under its label. An account is its label, host and family (cor:agt:140:01), so a
 * label that two hosts or families both wrote is ambiguous and is refused (bad input) unless the caller names which; the
 * caller can always disambiguate with `host` and `family`.
 */
function selectHistory(all: readonly UsageSnapshot[], host: string | null | undefined, family: string | null | undefined): UsageSnapshot[] {
  const rows = all.filter((s) => (host == null || s.host === host) && (family == null || s.family === family));
  const keys = new Set(rows.map((s) => `${s.host ?? ''}\u0000${s.family ?? ''}`));
  if (keys.size > 1) throw badInput('That account label has history from more than one host or family: name the host and family.');
  return rows;
}

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
    if (move.toAccount === account && (move.toHost ?? null) === null && (move.toFamily ?? null) === null) {
      throw badInput('moveWorker must name a different account than the one projected.');
    }
  }
  return { addWorkers: add, moveWorker: move };
}

/**
 * #3884 — the App-key arm of the account listing reads under the App's shared authority anchors in one transaction, which
 * Prisma caps at 5 s. The listing's work is bounded (at most MAX_EXAMINED_IDENTITIES history reads) but each read scans the
 * usage memory, so a large one passed the default and the key got INTERNAL_SERVER_ERROR where a participant was answered.
 * 30 s covers the measured worst case (about 6 s at 100k rows) with margin; a revoker of the key or App waits at most this long
 * for the shared anchors (cor:agt:050:23 sets no bound on that). Past this the cap still fires: an index on the per-selector
 * read is the structural fix and stays the owner's call (R5).
 */
export const ACCOUNT_LIST_KEY_TX_TIMEOUT_MS = 30_000;
/** #3907: the projection's key arm shares the listing's value (one number, one revoker wait). */
export const ACCOUNT_USAGE_KEY_TX_TIMEOUT_MS = ACCOUNT_LIST_KEY_TX_TIMEOUT_MS;

export const accountUsageQueries = {
  // #3853 (cor:agt:140:05): the accounts the projection would find history for. Same gate as the projection (no allowRun), no
  // arguments to judge, `c.db` so the key arm's read transaction is the one read.
  accountUsageAccounts: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) =>
    withReadableApp(ctx, appRef, async (c, app) => listUsageAccounts(c.db, app.id, new Date()), false, ACCOUNT_LIST_KEY_TX_TIMEOUT_MS),

  accountUsageProjection: async (
    _: unknown,
    { appRef, account, host, family, whatIf }: { appRef: string; account: string; host?: string | null; family?: string | null; whatIf?: WhatIfInput | null },
    ctx: Context,
  ) =>
    withReadableApp(ctx, appRef, async (c, app) => {
      // Judged only after the gate, so a caller outside the App learns nothing from a malformed argument either.
      if (account.length === 0 || account.length > MAX_LABEL) throw badInput('account must be an account label of 1 to 64 characters.');
      const what = parseWhatIf(whatIf, account);
      const asOf = new Date();
      const [source, target] = await loadAccountUsageCensus(c.db, app.id, asOf, [{ label: account, host, family }, ...(what?.moveWorker ? [{ label: what.moveWorker.toAccount, host: what.moveWorker.toHost, family: what.moveWorker.toFamily }] : [])]);
      // #3842 (V55): `incomplete` is set only when the probe spent its budget WITHOUT finding a second identity (finding one stops it
      // and the ambiguity is refused below), so it answers UNKNOWN here, never a definitive answer from one identity.
      const sourceIncomplete = source?.incomplete === true;
      const mine = sourceIncomplete ? [] : selectHistory(source?.snaps ?? [], host, family);
      const base = sourceIncomplete ? incompleteAccount() : projectAccount(mine, asOf);
      const latest = newest(mine);
      const result: Record<string, unknown> = {
        account,
        family: latest?.family ?? null,
        host: latest?.host ?? null,
        asOf,
        newestSnapshotAt: latest?.observedAt ?? null,
        workers: latest?.workers ?? [],
        workersConfigured: latest?.workersConfigured ?? false,
        windows: views(base),
        whatIf: null,
      };
      if (!what) return result;
      const current = latest && latest.workersConfigured ? latest.workers.length : 0;

      if (what.addWorkers != null) {
        // (an incomplete source has no calc, so withWorkerCount hands its UNKNOWN / HISTORY_INCOMPLETE windows back unchanged)
        result.whatIf = { adjusted: base.map((b) => view(withWorkerCount(b, current + what.addWorkers!).projection)), target: null };
        return result;
      }

      const move = what.moveWorker!;
      // A worker the account does not list cannot be moved (V33), whether or not the account has history.
      if (!sourceIncomplete && (!latest || !latest.workersConfigured || !latest.workers.includes(move.worker))) {
        throw badInput('The worker is not configured on that account.');
      }
      const targetIncomplete = target?.incomplete === true;
      const to = targetIncomplete ? [] : selectHistory(target?.snaps ?? [], move.toHost, move.toFamily);
      // Same account = same label, host and family (cor:agt:140:01), judged on the resolved identities, qualified or not.
      const toLatest = newest(to);
      if (move.toAccount === account
        && latest
        && (toLatest ? toLatest.host : move.toHost ?? null) === latest.host
        && (toLatest ? toLatest.family : move.toFamily ?? null) === latest.family) {
        throw badInput('moveWorker must name a different account than the one projected.');
      }
      const toBase = targetIncomplete ? incompleteAccount() : projectAccount(to, asOf);
      const sourceBurn = new Map(base.map((b) => [b.projection.window, b.projection.perWorkerBurn]));
      result.whatIf = {
        adjusted: base.map((b) => view(withWorkerCount(b, current - 1).projection)),
        target: {
          account: move.toAccount,
          baseline: views(toBase),
          // An unfinished source census gives the target no per-worker burn to add: every window UNKNOWN / HISTORY_INCOMPLETE (V55).
          adjusted: sourceIncomplete ? views(incompleteAccount()) : toBase.map((b) => view(addBurn(b, sourceBurn.get(b.projection.window) ?? null).projection)),
        },
      };
      return result;
    }, false, ACCOUNT_USAGE_KEY_TX_TIMEOUT_MS),
};
