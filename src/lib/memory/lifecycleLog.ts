/**
 * Lifecycle-log writers for the Memory soft-delete lifecycle
 * (011-soft-delete-memory FR-024 + data-model.md "MemoryLogEntry.detail
 * shapes").
 *
 * Two destination tables, picked per action:
 *
 *   MemoryLogEntry — for events whose retention is *tied to the memory*:
 *     - soft_delete, restore, sync_skipped_soft_deleted,
 *       subscriber_notified_owner_deleted, subscriber_notified_owner_restored
 *     These rows are cascade-removed with their parent Memory at hard-delete
 *     time, which is the desired behavior for these actions (they are part
 *     of the memory's life).
 *
 *   MemoryAuditLog — for events that document the deletion *itself*:
 *     - hard_delete, hard_delete_partial_failure, force_hard_delete
 *     The MemoryAuditLog table has no FK to Memory and survives the cascade.
 *
 * Each writer normalizes its detail payload to match the shape documented in
 * data-model.md so downstream consumers (incident-response queries, the
 * portal's memory-log view, the subscriber-side banner query) can rely on
 * field names being stable.
 */

import type { LogLevel, PrismaClient } from '../../generated/prisma/index.js';

type DbForMemoryLog = Pick<PrismaClient, 'memoryLogEntry'>;
type DbForAuditLog = Pick<PrismaClient, 'memoryAuditLog'>;

// ─── MemoryLogEntry writers ───────────────────────────────────────────

export type SoftDeleteLogInput = {
  memoryId: string;
  actor: string;        // user.id
  actorName: string;    // user.handle / display name at time of action
  memoryClass: 'knowledge';
};

/**
 * Writes a `MemoryLogEntry(LIFECYCLE / soft_delete)` row.
 * Caller is responsible for the actual `deleteMemory` mutation; this just
 * records the lifecycle event.
 */
export async function recordSoftDelete(
  db: DbForMemoryLog,
  input: SoftDeleteLogInput,
): Promise<void> {
  await db.memoryLogEntry.create({
    data: {
      memoryId: input.memoryId,
      level: 'INFO' as LogLevel,
      eventType: 'LIFECYCLE',
      message: `Memory soft-deleted by ${input.actorName}`,
      detail: {
        action: 'soft_delete',
        actor: input.actor,
        actorName: input.actorName,
        memoryClass: input.memoryClass,
      },
    },
  });
}

export type RestoreLogInput = {
  memoryId: string;
  actor: string;
  actorName: string;
  deletedAtBeforeRestore: Date;
  deletedByBeforeRestore: string | null;
};

/** Writes a `MemoryLogEntry(LIFECYCLE / restore)` row. */
export async function recordRestore(
  db: DbForMemoryLog,
  input: RestoreLogInput,
): Promise<void> {
  await db.memoryLogEntry.create({
    data: {
      memoryId: input.memoryId,
      level: 'INFO' as LogLevel,
      eventType: 'LIFECYCLE',
      message: `Memory restored by ${input.actorName}`,
      detail: {
        action: 'restore',
        actor: input.actor,
        actorName: input.actorName,
        deletedAtBeforeRestore: input.deletedAtBeforeRestore.toISOString(),
        deletedByBeforeRestore: input.deletedByBeforeRestore,
      },
    },
  });
}

export type SyncSkipLogInput = {
  memoryId: string;
  cycleId: string;
  syncStatusAtSkip: string; // existing Memory.syncStatus value
};

/**
 * Writes a `MemoryLogEntry(LIFECYCLE / sync_skipped_soft_deleted)` row.
 * The sync scheduler debounces at the per-memory level so this is called
 * at most once per memory per cycle (FR-005b).
 */
export async function recordSyncSkippedSoftDeleted(
  db: DbForMemoryLog,
  input: SyncSkipLogInput,
): Promise<void> {
  await db.memoryLogEntry.create({
    data: {
      memoryId: input.memoryId,
      level: 'DEBUG' as LogLevel,
      eventType: 'LIFECYCLE',
      message: 'Sync skipped: memory is soft-deleted',
      detail: {
        action: 'sync_skipped_soft_deleted',
        actor: 'system:sync-scheduler',
        cycleId: input.cycleId,
        syncStatusAtSkip: input.syncStatusAtSkip,
      },
    },
  });
}

// ─── MemoryAuditLog writers ───────────────────────────────────────────

export type CascadeCounts = {
  nodes: number;
  nodeVersions: number;
  edges: number;
  pendingEdgesIncoming: number;
  citations: number;
  memoryLogEntries: number;
  memorySubscriptions: number;
  memoryLicenses: number;
  agentMemoryItems: number;
  r2Objects: number;
};

export type HardDeleteAuditInput = {
  memoryId: string;
  memoryUrn: string;
  organizationId: string;
  organizationUrn: string;
  actor: string;            // 'system:retention-sweep' for sweep, ops user.id for CLI
  cascadeCounts: CascadeCounts;
  deletedAtAtSweep: Date;
  originalDeletedBy: string | null;
};

/**
 * Writes a `MemoryAuditLog(lifecycle / hard_delete)` row. Called by the
 * retention sweep before the cascade commits, so the row survives the
 * deletion of the parent Memory.
 */
export async function recordHardDelete(
  db: DbForAuditLog,
  input: HardDeleteAuditInput,
): Promise<void> {
  await db.memoryAuditLog.create({
    data: {
      memoryId: input.memoryId,
      memoryUrn: input.memoryUrn,
      organizationId: input.organizationId,
      organizationUrn: input.organizationUrn,
      eventType: 'lifecycle',
      action: 'hard_delete',
      actor: input.actor,
      detail: {
        cascadeCounts: input.cascadeCounts,
        deletedAtAtSweep: input.deletedAtAtSweep.toISOString(),
        originalDeletedBy: input.originalDeletedBy,
      },
    },
  });
}

export type HardDeletePartialFailureInput = {
  memoryId: string;
  memoryUrn: string;
  organizationId: string;
  organizationUrn: string;
  failedStep: 'r2_object_purge' | string;
  failedKey: string;
  errorMessage: string;
};

/**
 * Writes a `MemoryAuditLog(lifecycle / hard_delete_partial_failure)` row.
 * Invoked OUTSIDE the rolled-back deletion transaction so the audit row
 * persists even when the cascade is undone (FR-010).
 */
export async function recordHardDeletePartialFailure(
  db: DbForAuditLog,
  input: HardDeletePartialFailureInput,
): Promise<void> {
  await db.memoryAuditLog.create({
    data: {
      memoryId: input.memoryId,
      memoryUrn: input.memoryUrn,
      organizationId: input.organizationId,
      organizationUrn: input.organizationUrn,
      eventType: 'lifecycle',
      action: 'hard_delete_partial_failure',
      actor: 'system:retention-sweep',
      detail: {
        failedStep: input.failedStep,
        failedKey: input.failedKey,
        errorMessage: input.errorMessage,
        willRetryNextTick: true,
      },
    },
  });
}

export type ForceHardDeleteAuditInput = {
  memoryId: string;
  memoryUrn: string;
  organizationId: string;
  organizationUrn: string;
  operatorActor: string;     // ops user.id or handle
  operatorReason: string;
  cascadeCounts: CascadeCounts;
};

/**
 * Writes a `MemoryAuditLog(lifecycle / force_hard_delete)` row. Called by
 * the ops-only CLI (FR-005a) before the cascade commits.
 */
export async function recordForceHardDelete(
  db: DbForAuditLog,
  input: ForceHardDeleteAuditInput,
): Promise<void> {
  await db.memoryAuditLog.create({
    data: {
      memoryId: input.memoryId,
      memoryUrn: input.memoryUrn,
      organizationId: input.organizationId,
      organizationUrn: input.organizationUrn,
      eventType: 'lifecycle',
      action: 'force_hard_delete',
      actor: input.operatorActor,
      detail: {
        operatorReason: input.operatorReason,
        cascadeCounts: input.cascadeCounts,
        bypassedRetention: true,
      },
    },
  });
}
