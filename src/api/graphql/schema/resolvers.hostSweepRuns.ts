/**
 * #4233 (S10 of the Team on Orca epic, #4229) — the GraphQL surface of the sweep run record. The rules are
 * src/lib/agentTasks/sweepRuns.ts: what a run holds, the one summary post, the stale-sweep alarm.
 *
 * WHO WRITES `recordHostSweepRun`: a host key only, for its own host (cor:agt:070:04); the use is recorded in the write's
 * transaction (cor:agt:070:07), a refusal in its own write after it. The summary post is the platform's, after the commit.
 *
 * WHO READS `hostSweepRuns`: whoever reads the App's tasks and events (cor:agt:050:21), and a host key for ITS OWN host
 * only, as `hostDesiredState`: another host answers as one the App does not have.
 */

import type { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { taskError, withReadableApp } from './resolvers.agentTask.js';
import { asHost, recordingRefusal } from './resolvers.hostOperation.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { keyEverHeldHostOperate, keyHostId, recordHostKeyUse, recordHostKeyUseApart } from '../../../lib/hostOperations/hostKey.js';
import {
  insertSweepRun, needsSummary, postSweepSummaryDeferred, validateSweepRun, type SweepRunInput, type SweepRunLine,
} from '../../../lib/agentTasks/sweepRuns.js';

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const hostNotFound = (hostId: string): GraphQLError =>
  taskError('HOST_NOT_FOUND', 'No host with that id is registered in this App.', { hostId });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type Row = {
  id: string; hostId: string; runKey: string; startedAt: Date; endedAt: Date; mode: string;
  planned: number; applied: number; skipped: number; failed: number; lines: unknown; recordedAt: Date;
};
const project = (r: Row) => ({
  id: r.id, hostId: r.hostId, runId: r.runKey, startedAt: r.startedAt, endedAt: r.endedAt, mode: r.mode,
  planned: r.planned, applied: r.applied, skipped: r.skipped, failed: r.failed,
  lines: (Array.isArray(r.lines) ? r.lines : []) as SweepRunLine[], recordedAt: r.recordedAt,
});

export const hostSweepRunQueries = {
  /** The newest runs of one host's sweep (see the file header for who reads it). */
  hostSweepRuns: (_: unknown, a: { appRef: string; hostId: string; limit?: number | null }, ctx: Context) =>
    recordingRefusal(ctx, 'read', null, async () => {
      const hostId = typeof a.hostId === 'string' ? a.hostId.trim() : '';
      if (a.limit != null && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MAX_LIMIT)) throw badInput(`limit is 1 to ${MAX_LIMIT}.`);
      const limit = a.limit ?? DEFAULT_LIMIT;
      const out = await withReadableApp(ctx, a.appRef, async (c, app) => {
        const key = appKeyCaller(c);
        // Decided before the host is looked up, so a foreign host and a missing one cannot be told apart.
        if (key && (await keyEverHeldHostOperate(c.db, key.appKeyId)) && (await keyHostId(c.db, key)) !== hostId) throw hostNotFound(hostId);
        if (!hostId) throw hostNotFound(hostId);
        const known = await c.db.hostRegistration.findFirst({ where: { appId: app.id, hostId }, select: { id: true } })
          ?? await c.db.hostSweepRun.findFirst({ where: { appId: app.id, hostId }, select: { id: true } });
        if (!known) throw hostNotFound(hostId);
        const rows = await c.db.hostSweepRun.findMany({ where: { appId: app.id, hostId }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: limit });
        return rows.map((r) => project(r as unknown as Row));
      });
      const key = appKeyCaller(ctx);
      if (key) await recordHostKeyUseApart(ctx.db, key, 'read', { count: out.length });
      return out;
    }),
};

export const hostSweepRunMutations = {
  /** A host records one run of its sweep. Validated whole before any write; a replayed run token is the same run. */
  recordHostSweepRun: async (_: unknown, { input }: { input: SweepRunInput & { appRef: string } }, ctx: Context) =>
    recordingRefusal(ctx, 'sweep', null, async () => {
      if (!input) throw badInput('input is required.');
      const checked = validateSweepRun(input, new Date());
      if (!checked.ok) throw badInput(checked.message);
      let post: { appId: string; runId: string } | null = null;
      const row = await asHost(ctx, input.appRef, async (tx: Prisma.TransactionClient, app, host) => {
        const { id, created } = await insertSweepRun(tx, app.id, host.hostId, checked.run);
        if (created && needsSummary(checked.run)) post = { appId: app.id, runId: id };
        await recordHostKeyUse(tx, host, 'sweep', { count: checked.run.lines.length });
        return tx.hostSweepRun.findUniqueOrThrow({ where: { id } });
      });
      // After the commit, as the platform: the host key writes only the record (cor:agt:070:04).
      const p = post as { appId: string; runId: string } | null;
      if (p) postSweepSummaryDeferred(ctx.db, p.appId, p.runId);
      return project(row as unknown as Row);
    }),
};
