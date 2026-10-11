// Ticker authorization decisions — #1747, cor:agt:080:18, :20, :21.
//
// PURE: no I/O. The resolver gathers the facts inside the write's transaction
// (the re-read actor, `managesApp` on the transaction context, the grant row
// read FOR SHARE, the target worker's row) and asks here. Keeping the matrix in
// one pure function is what lets the tests walk every row of plan §5.
//
// "The worker itself" is a session bound to that worker with a person behind
// it. "The holder" is a PERSON acting as themselves (no worker session), so a
// holder who drives another worker's session does not inherit holder rights
// through it. "Whoever manages the App" counts a person acting as themselves
// only (`actorManagesApp`); a worker never inherits its driver's management.

export type PolicyActor =
  | { kind: 'worker'; workerId: string; userId: string | null }
  | { kind: 'user'; userId: string };

export type SubscribeAuthority = 'manager' | 'holder' | 'self' | 'grant';

export type SubscribeDecision =
  | { allow: true; authority: SubscribeAuthority }
  | { allow: false; code: 'SUBSCRIBE_FORBIDDEN' | 'SUBSCRIBE_CADENCE_NEEDS_HOLDER' };

/** cor:agt:080:20 — who may subscribe or unsubscribe a worker. */
export function decideSubscribe(i: {
  actor: PolicyActor;
  manages: boolean;
  op: 'subscribe' | 'unsubscribe';
  target: { id: string; heldByUserId: string | null };
  tickerCadenceSeconds: number;
  selfSubscribeCadenceSeconds: number;
  /** The actor is a worker holding a live grant, read FOR SHARE in this transaction. */
  hasGrant: boolean;
}): SubscribeDecision {
  const { actor, target } = i;
  if (i.manages) return { allow: true, authority: 'manager' };
  if (actor.kind === 'user' && target.heldByUserId !== null && target.heldByUserId === actor.userId) {
    return { allow: true, authority: 'holder' };
  }
  if (actor.kind === 'worker' && actor.workerId === target.id) {
    // R3: a worker spends its own tokens only at or below the self-subscription
    // cadence. It may always unsubscribe itself. The grant never reaches the
    // grantee itself (N1), so it cannot be used to beat this limit.
    if (i.op === 'unsubscribe' || i.tickerCadenceSeconds >= i.selfSubscribeCadenceSeconds) {
      return { allow: true, authority: 'self' };
    }
    return { allow: false, code: 'SUBSCRIBE_CADENCE_NEEDS_HOLDER' };
  }
  // N2: a person must be behind the call; a bare App key never reaches here
  // (the actor gate refuses it), and a worker actor with no person is refused.
  if (actor.kind === 'worker' && actor.userId !== null && i.hasGrant) {
    return { allow: true, authority: 'grant' };
  }
  return { allow: false, code: 'SUBSCRIBE_FORBIDDEN' };
}

/** cor:agt:080:18 — who may edit, disable or delete a ticker. */
export function mayEditTicker(i: {
  actor: PolicyActor;
  manages: boolean;
  ticker: { ownerUserId: string | null; ownerWorkerId: string | null };
  /** The holder of the owning worker, when the owner is a worker. */
  ownerWorkerHolderUserId: string | null;
}): boolean {
  if (i.manages) return true;
  const { actor, ticker } = i;
  if (actor.kind === 'user') {
    if (ticker.ownerUserId !== null && ticker.ownerUserId === actor.userId) return true;
    return ticker.ownerWorkerId !== null && i.ownerWorkerHolderUserId !== null && i.ownerWorkerHolderUserId === actor.userId;
  }
  return ticker.ownerWorkerId !== null && ticker.ownerWorkerId === actor.workerId;
}

/**
 * cor:agt:080:21 — who may change a worker's wake settings, in either direction:
 * the worker itself, its holder, whoever manages the App. NEVER the grant (N1).
 */
export function mayChangeWakeSettings(i: {
  actor: PolicyActor;
  manages: boolean;
  target: { id: string; heldByUserId: string | null };
}): boolean {
  if (i.manages) return true;
  const { actor, target } = i;
  if (actor.kind === 'worker') return actor.workerId === target.id;
  return target.heldByUserId !== null && target.heldByUserId === actor.userId;
}
