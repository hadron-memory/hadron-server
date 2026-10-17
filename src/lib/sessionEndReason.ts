import type { SessionEndReason } from '../generated/prisma/index.js';

/** #1156 / cor:dmo:070:05: an open row has no cause; legacy ends stay unknown.
 * Never infer a reason from summary, autoExpiredAt or the binder's provenance.
 */
export function sessionEndReason(session: { endedAt: Date | null; endReason?: SessionEndReason | null }): SessionEndReason | 'unknown' | null {
  return session.endedAt ? session.endReason ?? 'unknown' : null;
}
