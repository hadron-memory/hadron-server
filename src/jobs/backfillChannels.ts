/**
 * Spec 049 Phase 4 — the one-shot Channel backfill (plan §8.7, closes the
 * data half of #1047).
 *
 * Every team chat that exists today is a `chats:team` root in an app-class
 * memory with NO Channel row. This job gives each one its row — an
 * APPLICATION backfill, not SQL, because the row's `lastSeq` must agree with
 * the allocator (`highWaterSeq` in chatRoot.ts: the greater of the root's
 * `messageCount` and the actual MAX(seq) over message-type rows, deleted ones
 * INCLUDED — a seq is never reused) — and because the App's default is a
 * choice (the oldest live root among the App's app-class memories, exactly
 * as `locateTeamChatRoot` chooses), not a column.
 *
 * Roots in SOFT-DELETED memories are swept too (a restored memory must come
 * back protected), and tombstoned roots get TOMBSTONED rows: the address
 * stays reserved and a restore brings the row back with it. Apps that never
 * posted get their default Channel created (eager D-006) in their team-space
 * memory — resolved by the canonical team-space resolver, then the Team
 * Agent locator when several qualify; an App that stays ambiguous is
 * reported, not guessed.
 *
 * Encrypted roots: `messageCount` sits inside the encrypted `data` blob and
 * no session key is available to a job, so the watermark is MAX(seq) alone
 * (seq is a plaintext column). That equals the allocator's answer unless
 * messages were HARD-deleted or imported without seq; such roots are counted
 * in `encryptedRoots` so the operator knows which watermarks to eyeball.
 *
 * Idempotent: a row that exists is only ever RAISED to the computed
 * watermark, never lowered — atomically (`lastSeq < computed`), so a post
 * landing mid-run cannot be regressed. Dry run by default; `--apply` writes.
 *
 *   pnpm tsx src/jobs/backfillChannels.ts [--apply]
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolveAppTeamSpaceMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { locateTeamAgent } from '../api/graphql/schema/resolvers.worker.js';
import { DEFAULT_CHANNEL_NAME, ensureChannelRow, ensureChannelWithRoot, lockMemoryForChannelChange } from '../lib/channels.js';
import { ensureInstallRegisterRows } from '../lib/registerInstall.js';
import { TEAM_CHAT_LOC } from '../lib/teamChatLoc.js';
import { escapePrismaLikePattern, maxMessageSeqAtLiteralLocPrefix } from '../lib/literalLocPrefix.js';

/** The message nodeTypes the allocator counts — mirrors chatRoot.ts. */
const MESSAGE_NODE_TYPES = ['chat-message', 'record'];

export interface BackfillReport {
  apply: boolean;
  rootsSeen: number;
  rowsCreated: number;
  rowsRaised: number;
  rowsTombstoned: number;
  /** Roots whose `messageCount` is encrypted — watermark from MAX(seq) alone. */
  encryptedRoots: number;
  defaultsSet: number;
  defaultsProvisioned: number;
  /** Apps with no root and several team-space memories the locator could not separate. */
  ambiguousApps: Array<{ appId: string; appName: string; memoryIds: string[] }>;
  /** Apps with no root and no team-space memory at all. */
  noMemoryApps: number;
  /** Spec 049 Phase 5 — install-created register rows written (or, dry, missing). */
  registerRowsCreated: number;
}

/** The allocator's high-water mark for one root, computed the way it computes it. */
async function highWater(
  db: PrismaClient | Prisma.TransactionClient,
  root: { memoryId: string; loc: string; data: unknown },
): Promise<{ lastSeq: number; encrypted: boolean }> {
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? (root.data as Record<string, unknown>) : {};
  const encrypted = '__enc' in data;
  const counter = !encrypted && typeof data.messageCount === 'number' ? data.messageCount : 0;
  const top = await maxMessageSeqAtLiteralLocPrefix(db, root.memoryId, `${root.loc}:messages:`);
  return { lastSeq: Math.max(counter, top), encrypted };
}

/**
 * The team-space memory a never-posted App's default Channel goes in. One
 * candidate: it. Several: the Team Agent's (the marker default, or the single
 * live installed Agent — the same fallback the bootstrap uses). Else null.
 */
async function pickTeamSpace(
  db: PrismaClient,
  appId: string,
  candidates: string[],
): Promise<string | null> {
  if (candidates.length === 1) return candidates[0];
  const ctx = { db } as Context;
  let agentId: string | null = null;
  try {
    agentId = (await locateTeamAgent(ctx, appId, null)).id;
  } catch {
    const installed = await db.appAgent.findMany({
      where: { appId },
      select: { agent: { select: { id: true, deletedAt: true } } },
    });
    const live = installed.map((r) => r.agent).filter((a) => a && !a.deletedAt);
    if (live.length === 1) agentId = live[0].id;
  }
  if (!agentId) return null;
  const owned = await db.memory.findFirst({
    where: { id: { in: candidates }, sharedMemoryOfAgentId: agentId },
    select: { id: true },
  });
  return owned?.id ?? null;
}

export async function backfillChannels(db: PrismaClient, opts: { apply: boolean }): Promise<BackfillReport> {
  const report: BackfillReport = {
    apply: opts.apply,
    rootsSeen: 0,
    rowsCreated: 0,
    rowsRaised: 0,
    rowsTombstoned: 0,
    encryptedRoots: 0,
    defaultsSet: 0,
    defaultsProvisioned: 0,
    ambiguousApps: [],
    noMemoryApps: 0,
    registerRowsCreated: 0,
  };

  // 1. Every team-chat root in an app-class memory — tombstoned roots AND
  //    soft-deleted memories included (Codex on PR #1165).
  const roots = await db.node.findMany({
    // loc-scope-ok: a platform sweep over every app-class memory.
    where: { loc: TEAM_CHAT_LOC, memory: { class: 'app' } },
    select: { id: true, memoryId: true, loc: true, data: true, deletedAt: true, createdBy: true, memory: { select: { appId: true, app: { select: { name: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  report.rootsSeen = roots.length;
  for (const root of roots) {
    const inspect = async (scope: PrismaClient | Prisma.TransactionClient, fresh: typeof root) => {
      const { lastSeq, encrypted } = await highWater(scope, fresh);
      const lastMessage = await scope.node.findFirst({
        where: {
          memoryId: fresh.memoryId,
          loc: { startsWith: escapePrismaLikePattern(`${fresh.loc}:messages:`) },
          nodeType: { in: MESSAGE_NODE_TYPES },
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const existing = await scope.channel.findUnique({ where: { chatRootNodeId: fresh.id } });
      return { lastSeq, encrypted, lastMessage, existing };
    };

    if (!opts.apply) {
      const state = await inspect(db, root);
      if (state.encrypted) report.encryptedRoots += 1;
      if (!state.existing) {
        report.rowsCreated += 1;
        if (root.deletedAt) report.rowsTombstoned += 1;
      } else if (state.existing.incarnation === 1 && state.existing.lastSeq < state.lastSeq) {
        report.rowsRaised += 1;
      }
      continue;
    }

    const outcome = await db.$transaction(async (tx) => {
      // Creation/reuse and backfill share this lock. All root state and the
      // transcript watermark are re-read after the grant, so an old snapshot
      // cannot tombstone or regress a newly reused Channel incarnation.
      await lockMemoryForChannelChange(tx, root.memoryId);
      const fresh = await tx.node.findUnique({
        where: { id: root.id },
        select: {
          id: true,
          memoryId: true,
          loc: true,
          data: true,
          deletedAt: true,
          createdBy: true,
          memory: { select: { appId: true, app: { select: { name: true } } } },
        },
      });
      if (!fresh || fresh.memoryId !== root.memoryId || fresh.loc !== TEAM_CHAT_LOC) return null;
      const state = await inspect(tx, fresh);
      if (!state.existing) {
        const row = await ensureChannelRow(tx, {
          rootId: fresh.id,
          memoryId: fresh.memoryId,
          loc: fresh.loc,
          name: DEFAULT_CHANNEL_NAME,
          description: fresh.memory.app ? `Team chat — ${fresh.memory.app.name}` : null,
          createdBy: fresh.createdBy ?? null,
          lastSeq: state.lastSeq,
        });
        await tx.channel.update({
          where: { id: row.id },
          data: {
            lastMessageAt: state.lastMessage?.createdAt ?? null,
            ...(fresh.deletedAt ? { deletedAt: fresh.deletedAt } : {}),
          },
        });
        return { encrypted: state.encrypted, created: true, tombstoned: !!fresh.deletedAt, raised: false };
      }
      // Incarnation > 1 means clean reuse deliberately reset the live
      // transcript watermark to zero while retaining allocator history. The
      // one-shot legacy repair must not turn that history back into phantom
      // attention for the new room.
      if (state.existing.incarnation === 1 && state.existing.lastSeq < state.lastSeq) {
        await tx.channel.updateMany({
          where: { id: state.existing.id, lastSeq: { lt: state.lastSeq } },
          data: { lastSeq: state.lastSeq },
        });
        return { encrypted: state.encrypted, created: false, tombstoned: false, raised: true };
      }
      return { encrypted: state.encrypted, created: false, tombstoned: false, raised: false };
    });
    if (!outcome) continue;
    if (outcome.encrypted) report.encryptedRoots += 1;
    if (outcome.created) report.rowsCreated += 1;
    if (outcome.tombstoned) report.rowsTombstoned += 1;
    if (outcome.raised) report.rowsRaised += 1;
  }

  // 2. Every App's default: the oldest LIVE root among its app-class memories;
  //    an App that never posted gets one provisioned in its team space.
  const apps = await db.app.findMany({
    where: { deletedAt: null, defaultChannelId: null },
    select: { id: true, name: true, createdBy: true },
  });
  for (const app of apps) {
    const liveRoot = await db.node.findFirst({
      // loc-scope-ok: the App's own app-class memories are the tenant scope.
      where: { loc: TEAM_CHAT_LOC, deletedAt: null, memory: { appId: app.id, class: 'app', deletedAt: null } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (liveRoot) {
      report.defaultsSet += 1;
      if (opts.apply) {
        const row = await db.channel.findUnique({ where: { chatRootNodeId: liveRoot.id }, select: { id: true } });
        if (row) await db.app.updateMany({ where: { id: app.id, defaultChannelId: null }, data: { defaultChannelId: row.id } });
      }
      continue;
    }
    const candidates = await resolveAppTeamSpaceMemoryIds(db, app.id);
    if (candidates.length === 0) {
      report.noMemoryApps += 1;
      continue;
    }
    const memoryId = await pickTeamSpace(db, app.id, candidates);
    if (!memoryId) {
      report.ambiguousApps.push({ appId: app.id, appName: app.name, memoryIds: candidates });
      continue;
    }
    report.defaultsProvisioned += 1;
    if (opts.apply) {
      // A refused provisioning (including DECISION_CONTAINED) aborts this run;
      // prior items are committed separately. Fix the placement before retrying.
      await ensureChannelWithRoot(db, {
        memoryId,
        loc: TEAM_CHAT_LOC,
        name: DEFAULT_CHANNEL_NAME,
        description: `Team chat — ${app.name}`,
        createdBy: app.createdBy ?? null,
        asDefaultOfAppId: app.id,
        hostLabel: app.name,
      });
    }
  }

  // 3. Spec 049 Phase 5 (§7.3): every live install of an App with a default
  //    Channel has its materialised register row. Idempotent on the partial
  //    unique; the migration wrote these for Apps that already had a default,
  //    this covers the ones step 2 just gave one.
  const withDefault = await db.app.findMany({
    where: { deletedAt: null, defaultChannelId: { not: null } },
    select: { id: true, createdBy: true },
  });
  for (const app of withDefault) {
    if (opts.apply) {
      report.registerRowsCreated += await ensureInstallRegisterRows(db, app.id, { createdBy: app.createdBy ?? null });
    } else {
      const installs = await db.appAgent.count({ where: { appId: app.id, agent: { deletedAt: null } } });
      const rows = await db.registerEntry.count({ where: { appId: app.id, installDefault: true, deletedAt: null } });
      report.registerRowsCreated += Math.max(0, installs - rows);
    }
  }
  return report;
}

// Hand-run entry point.
if (process.argv[1] && process.argv[1].endsWith('backfillChannels.ts')) {
  const { db: prisma } = await import('../integrations/db/client.js');
  const apply = process.argv.includes('--apply');
  const report = await backfillChannels(prisma, { apply });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log('\nDry run — re-run with --apply to write.');
  await prisma.$disconnect();
}
