/** #2025 typed timing seam consumed by S1 (#2017) and S5 (#2021).
 * No clock reads or local defaults: callers supply the message/activity times
 * and the effective settings loaded for the deciding App.
 */
import type { DeliverySettings } from './deliverySettings.js';
export { loadDeliverySettings } from './deliverySettings.js';

/** S1: oldest-post busy deadline (Holger, #2025 comment6246801585).
 * The window opens at the first still-due post after the last delivery
 * (Holger D4; Vera #2059 comment6247138701); later arrivals never slide it.
 * A shorter busy delay retains the window floor (Proposed edge).
 * Wake ceiling is a separate S1 check; overflow retains its original post time. */
export function batchTiming(
  settings: DeliverySettings,
  input: { oldestPostedAt: Date; busyUntil?: Date },
): { deliverAfter: Date; busyDeadline: Date } {
  const deadline = input.oldestPostedAt.getTime() + settings.busyDelaySeconds * 1000;
  const windowEnd = input.oldestPostedAt.getTime() + settings.batchWindowSeconds * 1000;
  const after = Math.max(windowEnd, Math.min(input.busyUntil?.getTime() ?? 0, deadline));
  return { deliverAfter: new Date(after), busyDeadline: new Date(deadline) };
}

/** S5: deadline only; the owning evaluator decides eligibility, comparison and episode lifecycle. */
export function deliveryStuckAt(settings: DeliverySettings, oldestDueAt: Date): Date {
  return new Date(oldestDueAt.getTime() + settings.stuckWindowSeconds * 1000);
}
