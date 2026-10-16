/**
 * #1632 / cor:dmo:130:04 — a signature's state, derived on every read and
 * never stored. Pure: the caller supplies the record's verification verdict,
 * its passkey's window/revocation columns, the node's content-change marker
 * and whether its memory is encrypted.
 */

export type SignatureState = 'CURRENT' | 'EARLIER' | 'PENDING' | 'CANCELLED' | 'NOT_APPLICABLE' | 'ENDED_ENCRYPTED_MEMORY';

export interface SignatureStateInput {
  verifiedAt: Date;
  /** Did the stored assertion re-verify? An invalid record is never a signature (#9853). */
  valid: boolean;
  passkey: { revokedAt: Date | null; windowEndsAt: Date | null; windowEndedAt: Date | null; windowOutcome: string | null };
  /** nodes.content_changed_at: the last title/abstract/content change, null if none. */
  contentChangedAt: Date | null;
  memoryEncrypted: boolean;
  now: Date;
}

/**
 * - NOT_APPLICABLE wins while the node is in an encrypted memory (#9851).
 *   (ENDED_ENCRYPTED_MEMORY needs the time a node entered one; leaving is E2.)
 * - An invalid record is 'INVALID': reported as an integrity problem, never listed.
 * - A signature made inside its first passkey's window reads CANCELLED if the
 *   passkey was revoked in the window by any route (#10398); PENDING while the
 *   window is open, EARLIER instead once content changed (#10014); after the
 *   window ends normally (ran out or ended early) it counts (#10013).
 * - Otherwise EARLIER once title/abstract/content changed at or after it was
 *   verified (same-millisecond counts as changed: the safe side), else CURRENT.
 *   A restore is a change, so it never revives a signature (#9824).
 */
export function deriveSignatureState(i: SignatureStateInput): SignatureState | 'INVALID' {
  if (i.memoryEncrypted) return 'NOT_APPLICABLE';
  if (!i.valid) return 'INVALID';
  const t = i.verifiedAt.getTime();
  const changed = i.contentChangedAt !== null && i.contentChangedAt.getTime() >= t;
  const { revokedAt, windowEndsAt, windowEndedAt, windowOutcome } = i.passkey;
  const madeInWindow = windowEndsAt !== null && t < windowEndsAt.getTime()
    && (windowEndedAt === null || t < windowEndedAt.getTime());
  if (madeInWindow) {
    const revokedInWindow = revokedAt !== null && revokedAt.getTime() < windowEndsAt!.getTime()
      && (windowEndedAt === null || revokedAt.getTime() <= windowEndedAt.getTime());
    if (windowOutcome === 'cancelled' || revokedInWindow) return 'CANCELLED';
    const windowOpen = windowEndedAt === null && i.now.getTime() < windowEndsAt!.getTime();
    if (windowOpen) return changed ? 'EARLIER' : 'PENDING';
  }
  return changed ? 'EARLIER' : 'CURRENT';
}

const ROLLUP_ORDER: SignatureState[] = ['CURRENT', 'PENDING', 'EARLIER', 'CANCELLED'];

/** The node-level roll-up: the best state any signature has; null with no signatures. */
export function rollUpSignatureState(states: SignatureState[], memoryEncrypted: boolean): SignatureState | null {
  if (memoryEncrypted) return 'NOT_APPLICABLE';
  for (const s of ROLLUP_ORDER) if (states.includes(s)) return s;
  return states[0] ?? null;
}

/** cor:dmo:130:06: current signers first, then newest first. */
export function compareSignaturesForDisplay(a: { state: SignatureState; verifiedAt: Date }, b: { state: SignatureState; verifiedAt: Date }): number {
  const ac = a.state === 'CURRENT' ? 0 : 1;
  const bc = b.state === 'CURRENT' ? 0 : 1;
  return ac - bc || b.verifiedAt.getTime() - a.verifiedAt.getTime();
}
