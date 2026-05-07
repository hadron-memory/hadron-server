import { describe, expect, it, vi } from 'vitest';
import {
  recordForceHardDelete,
  recordHardDelete,
  recordHardDeletePartialFailure,
  recordRestore,
  recordSoftDelete,
  recordSyncSkippedSoftDeleted,
  type CascadeCounts,
} from './lifecycleLog.js';

type CreateArgs = { data: Record<string, unknown> };

function makeMemoryLogDb() {
  const create = vi.fn(async (_args: CreateArgs) => ({}));
  return {
    memoryLogEntry: { create },
    create,
  };
}

function makeAuditLogDb() {
  const create = vi.fn(async (_args: CreateArgs) => ({}));
  return {
    memoryAuditLog: { create },
    create,
  };
}

const sampleCounts: CascadeCounts = {
  nodes: 50,
  nodeVersions: 23,
  edges: 18,
  pendingEdgesIncoming: 2,
  citations: 5,
  memoryLogEntries: 14,
  memorySubscriptions: 3,
  memoryLicenses: 1,
  agentMemoryItems: 2,
  r2Objects: 7,
};

describe('recordSoftDelete', () => {
  it('writes a MemoryLogEntry row with action=soft_delete and the actor fields', async () => {
    const db = makeMemoryLogDb();
    await recordSoftDelete(db as never, {
      memoryId: 'mem_a',
      actor: 'usr_alice',
      actorName: 'Alice',
      memoryClass: 'knowledge',
    });
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memoryId: 'mem_a',
        eventType: 'LIFECYCLE',
        level: 'INFO',
        detail: {
          action: 'soft_delete',
          actor: 'usr_alice',
          actorName: 'Alice',
          memoryClass: 'knowledge',
        },
      }),
    });
  });
});

describe('recordRestore', () => {
  it('captures the before-state in the detail payload', async () => {
    const db = makeMemoryLogDb();
    const deletedAtBefore = new Date('2026-05-01T00:00:00Z');
    await recordRestore(db as never, {
      memoryId: 'mem_a',
      actor: 'usr_bob',
      actorName: 'Bob',
      deletedAtBeforeRestore: deletedAtBefore,
      deletedByBeforeRestore: 'usr_alice',
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detail: {
          action: 'restore',
          actor: 'usr_bob',
          actorName: 'Bob',
          deletedAtBeforeRestore: deletedAtBefore.toISOString(),
          deletedByBeforeRestore: 'usr_alice',
        },
      }),
    });
  });

  it('handles a null deletedByBeforeRestore (legacy soft-deleted rows)', async () => {
    const db = makeMemoryLogDb();
    await recordRestore(db as never, {
      memoryId: 'mem_a',
      actor: 'usr_bob',
      actorName: 'Bob',
      deletedAtBeforeRestore: new Date('2026-04-01T00:00:00Z'),
      deletedByBeforeRestore: null,
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detail: expect.objectContaining({ deletedByBeforeRestore: null }),
      }),
    });
  });
});

describe('recordSyncSkippedSoftDeleted', () => {
  it('writes a DEBUG-level MemoryLogEntry tagged with the cycleId', async () => {
    const db = makeMemoryLogDb();
    await recordSyncSkippedSoftDeleted(db as never, {
      memoryId: 'mem_x',
      cycleId: 'cyc_2026-05-08T06:00:00Z',
      syncStatusAtSkip: 'OK',
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        level: 'DEBUG',
        eventType: 'LIFECYCLE',
        detail: expect.objectContaining({
          action: 'sync_skipped_soft_deleted',
          actor: 'system:sync-scheduler',
          cycleId: 'cyc_2026-05-08T06:00:00Z',
          syncStatusAtSkip: 'OK',
        }),
      }),
    });
  });
});

describe('recordHardDelete', () => {
  it('writes a MemoryAuditLog row with cascade counts and original deleter', async () => {
    const db = makeAuditLogDb();
    const sweepAt = new Date('2026-06-15T00:00:00Z');
    await recordHardDelete(db as never, {
      memoryId: 'mem_x',
      memoryUrn: 'acme.test:notes',
      organizationId: 'org_acme',
      organizationUrn: 'acme.test',
      actor: 'system:retention-sweep',
      cascadeCounts: sampleCounts,
      deletedAtAtSweep: sweepAt,
      originalDeletedBy: 'usr_alice',
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memoryUrn: 'acme.test:notes',
        action: 'hard_delete',
        actor: 'system:retention-sweep',
        detail: {
          cascadeCounts: sampleCounts,
          deletedAtAtSweep: sweepAt.toISOString(),
          originalDeletedBy: 'usr_alice',
        },
      }),
    });
  });

  it('preserves null originalDeletedBy (legacy rows had no deletedBy)', async () => {
    const db = makeAuditLogDb();
    await recordHardDelete(db as never, {
      memoryId: 'mem_x',
      memoryUrn: 'acme.test:legacy',
      organizationId: 'org_acme',
      organizationUrn: 'acme.test',
      actor: 'system:retention-sweep',
      cascadeCounts: sampleCounts,
      deletedAtAtSweep: new Date('2026-06-15T00:00:00Z'),
      originalDeletedBy: null,
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detail: expect.objectContaining({ originalDeletedBy: null }),
      }),
    });
  });
});

describe('recordHardDeletePartialFailure', () => {
  it('captures the failed step and key for retry on next tick', async () => {
    const db = makeAuditLogDb();
    await recordHardDeletePartialFailure(db as never, {
      memoryId: 'mem_x',
      memoryUrn: 'acme.test:notes',
      organizationId: 'org_acme',
      organizationUrn: 'acme.test',
      failedStep: 'r2_object_purge',
      failedKey: 'assets/2026/05/abc123.pdf',
      errorMessage: '503 Service Unavailable',
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hard_delete_partial_failure',
        detail: expect.objectContaining({
          failedStep: 'r2_object_purge',
          failedKey: 'assets/2026/05/abc123.pdf',
          willRetryNextTick: true,
        }),
      }),
    });
  });
});

describe('recordForceHardDelete', () => {
  it('writes a MemoryAuditLog row tagged with operator reason and bypassedRetention=true', async () => {
    const db = makeAuditLogDb();
    await recordForceHardDelete(db as never, {
      memoryId: 'mem_x',
      memoryUrn: 'acme.test:notes',
      organizationId: 'org_acme',
      organizationUrn: 'acme.test',
      operatorActor: 'usr_ops',
      operatorReason: 'GDPR Art.17 erasure request, ticket #LEGAL-1234',
      cascadeCounts: sampleCounts,
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'force_hard_delete',
        actor: 'usr_ops',
        detail: expect.objectContaining({
          operatorReason: expect.stringContaining('LEGAL-1234'),
          bypassedRetention: true,
        }),
      }),
    });
  });
});
