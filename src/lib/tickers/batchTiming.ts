/** #2025 typed timing seam consumed by S1 (#2017) and S5 (#2021).
 * No clock reads or local defaults: callers supply the message/activity times
 * and the effective settings loaded for the deciding App.
 */
import type { DeliverySettings } from './deliverySettings.js';
export { loadDeliverySettings } from './deliverySettings.js';

/** S1: newest-message batching; the hard busy deadline always starts at the oldest waiting post (Holger, #2025 comment6246801585). */
export function batchTiming(
  settings: DeliverySettings,
  input: { oldestPostedAt: Date; lastDueMessageAt: Date; busyUntil?: Date },
): { deliverAfter: Date; busyDeadline: Date } {
  const after = Math.max(input.lastDueMessageAt.getTime() + settings.batchWindowSeconds * 1000, input.busyUntil?.getTime() ?? 0);
  return { deliverAfter: new Date(after), busyDeadline: new Date(input.oldestPostedAt.getTime() + settings.busyDelaySeconds * 1000) };
}

/** S5: deadline only; the owning evaluator decides eligibility, comparison and episode lifecycle. */
export function deliveryStuckAt(settings: DeliverySettings, oldestDueAt: Date): Date {
  return new Date(oldestDueAt.getTime() + settings.stuckWindowSeconds * 1000);
}
