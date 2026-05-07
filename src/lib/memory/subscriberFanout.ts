/**
 * Subscriber-side notification fan-out for soft-delete and restore events
 * (011-soft-delete-memory FR-015a, R-10).
 *
 * When an owning org soft-deletes (or restores) a knowledge memory, every
 * subscribing org needs to know — their agents and apps suddenly stop (or
 * resume) seeing the memory. This helper iterates the `MemorySubscription`
 * rows pointing at the deleted memory and writes one `MemoryLogEntry` row
 * per subscribing org. Each row is keyed on the deleted memory's id (so
 * subscribers find it by joining their own subscriptions); the detail
 * payload carries the subscribing-org id alongside the owner-org metadata.
 *
 * No email or push notification in the MVP — banner + log only (per Q5
 * answer). Subscribers' portals query these rows on listing pages and
 * agent-detail pages and render `<SubscriberBanner>` from the result.
 *
 * Idempotency: repeat invocations on the same memory write duplicate rows.
 * The caller (the `deleteMemory` / `restoreMemory` resolver) is responsible
 * for invoking the fan-out exactly once per state transition.
 */

import type { LogLevel, PrismaClient } from '../../generated/prisma/index.js';

type DbForFanout = Pick<PrismaClient, 'memorySubscription' | 'memoryLogEntry'>;

export type FanoutContext = {
  /** The memory whose owner just performed soft-delete or restore. */
  memoryId: string;
  memoryName: string;
  memoryUrn: string;
  owningOrgId: string;
  owningOrgName: string;
  /** The user.id of the owner-side actor who triggered the state change. */
  actor: string;
};

/**
 * Fan out one `MemoryLogEntry(LIFECYCLE / subscriber_notified_owner_deleted)`
 * per subscribing org. Returns the number of rows written.
 */
export async function fanoutOwnerDeleted(
  db: DbForFanout,
  ctx: FanoutContext,
): Promise<number> {
  return fanout(db, ctx, 'subscriber_notified_owner_deleted');
}

/** Symmetric fan-out for the restore event. */
export async function fanoutOwnerRestored(
  db: DbForFanout,
  ctx: FanoutContext,
): Promise<number> {
  return fanout(db, ctx, 'subscriber_notified_owner_restored');
}

async function fanout(
  db: DbForFanout,
  ctx: FanoutContext,
  action:
    | 'subscriber_notified_owner_deleted'
    | 'subscriber_notified_owner_restored',
): Promise<number> {
  const subs = await db.memorySubscription.findMany({
    where: { memoryId: ctx.memoryId },
    select: { organizationId: true },
  });
  if (subs.length === 0) {
    return 0;
  }
  // Caller's responsibility to wrap in a transaction with the lifecycle
  // change itself; we just emit the rows.
  await db.memoryLogEntry.createMany({
    data: subs.map((s) => ({
      memoryId: ctx.memoryId,
      level: 'INFO' as LogLevel,
      eventType: 'LIFECYCLE' as const,
      message:
        action === 'subscriber_notified_owner_deleted'
          ? `Owner ${ctx.owningOrgName} deleted memory ${ctx.memoryName}`
          : `Owner ${ctx.owningOrgName} restored memory ${ctx.memoryName}`,
      detail: {
        action,
        actor: 'system:lifecycle-fanout',
        subscribingOrgId: s.organizationId,
        owningOrgId: ctx.owningOrgId,
        owningOrgName: ctx.owningOrgName,
        memoryName: ctx.memoryName,
        memoryUrn: ctx.memoryUrn,
        deletedByActor: ctx.actor,
      },
    })),
  });
  return subs.length;
}
