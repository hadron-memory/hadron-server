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
 * Tombstoned roots get TOMBSTONED rows: the address stays protected (a
 * deleted chat still occupies it) and a restore brings the row back with it.
 * Apps that never posted get their default Channel created (eager D-006) —
 * when the shared app-class memory is unambiguous; an App with several and
 * no root is reported, not guessed.
 *
 * Idempotent: a row that exists is only ever RAISED to the computed
 * watermark, never lowered. Dry run by default; `--apply` writes.
 *
 *   pnpm tsx src/jobs/backfillChannels.ts [--apply]
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { DEFAULT_CHANNEL_NAME, ensureChannelRow, ensureChannelWithRoot } from '../lib/channels.js';
import { TEAM_CHAT_LOC } from '../lib/teamChatLoc.js';

/** The message nodeTypes the allocator counts — mirrors chatRoot.ts. */
const MESSAGE_NODE_TYPES = ['chat-message', 'record'];

export interface BackfillReport {
  apply: boolean;
  rootsSeen: number;
  rowsCreated: number;
  rowsRaised: number;
  rowsTombstoned: number;
  defaultsSet: number;
  defaultsProvisioned: number;
  /** Apps with no root and several shared app-class memories — not guessed. */
  ambiguousApps: Array<{ appId: string; appName: string; memoryIds: string[] }>;
  /** Apps with no root and no shared app-class memory at all. */
  noMemoryApps: number;
}

/** The allocator's high-water mark for one root, computed the way it computes it. */
async function highWater(db: PrismaClient, root: { memoryId: string; loc: string; data: unknown }): Promise<number> {
  const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : {};
  const counter = typeof data.messageCount === 'number' ? data.messageCount : 0;
  const top = await db.node.aggregate({
    where: {
      memoryId: root.memoryId,
      loc: { startsWith: `${root.loc}:messages:` },
      nodeType: { in: MESSAGE_NODE_TYPES },
      seq: { not: null },
    },
    _max: { seq: true },
  });
  return Math.max(counter, top._max?.seq ?? 0);
}

export async function backfillChannels(db: PrismaClient, opts: { apply: boolean }): Promise<BackfillReport> {
  const report: BackfillReport = {
    apply: opts.apply,
    rootsSeen: 0,
    rowsCreated: 0,
    rowsRaised: 0,
    rowsTombstoned: 0,
    defaultsSet: 0,
    defaultsProvisioned: 0,
    ambiguousApps: [],
    noMemoryApps: 0,
  };

  // 1. Every team-chat root in an app-class memory, tombstones included.
  const roots = await db.node.findMany({
    // loc-scope-ok: a platform sweep over every app-class memory.
    where: { loc: TEAM_CHAT_LOC, memory: { class: 'app', deletedAt: null } },
    select: { id: true, memoryId: true, loc: true, data: true, deletedAt: true, createdBy: true, memory: { select: { appId: true, app: { select: { name: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  report.rootsSeen = roots.length;
  for (const root of roots) {
    const lastSeq = await highWater(db, root);
    const lastMessage = await db.node.findFirst({
      where: { memoryId: root.memoryId, loc: { startsWith: `${root.loc}:messages:` }, nodeType: { in: MESSAGE_NODE_TYPES }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const existing = await db.channel.findUnique({ where: { chatRootNodeId: root.id } });
    if (!existing) {
      report.rowsCreated += 1;
      if (root.deletedAt) report.rowsTombstoned += 1;
      if (opts.apply) {
        const row = await ensureChannelRow(db, {
          rootId: root.id,
          memoryId: root.memoryId,
          loc: root.loc,
          name: DEFAULT_CHANNEL_NAME,
          description: root.memory.app ? `Team chat — ${root.memory.app.name}` : null,
          createdBy: root.createdBy ?? null,
          lastSeq,
        });
        await db.channel.update({
          where: { id: row.id },
          data: { lastMessageAt: lastMessage?.createdAt ?? null, ...(root.deletedAt ? { deletedAt: root.deletedAt } : {}) },
        });
      }
    } else if (existing.lastSeq < lastSeq) {
      report.rowsRaised += 1;
      if (opts.apply) await db.channel.update({ where: { id: existing.id }, data: { lastSeq } });
    }
  }

  // 2. Every App's default: the oldest LIVE root among its app-class memories;
  //    an App that never posted gets one provisioned when its shared memory is
  //    unambiguous.
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
    const shared = await db.memory.findMany({
      where: { appId: app.id, class: 'app', deletedAt: null, userMemoryOfAgentId: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (shared.length === 0) {
      report.noMemoryApps += 1;
      continue;
    }
    if (shared.length > 1) {
      report.ambiguousApps.push({ appId: app.id, appName: app.name, memoryIds: shared.map((m) => m.id) });
      continue;
    }
    report.defaultsProvisioned += 1;
    if (opts.apply) {
      await ensureChannelWithRoot(db, {
        memoryId: shared[0].id,
        loc: TEAM_CHAT_LOC,
        name: DEFAULT_CHANNEL_NAME,
        description: `Team chat — ${app.name}`,
        createdBy: app.createdBy ?? null,
        asDefaultOfAppId: app.id,
        hostLabel: app.name,
      });
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
