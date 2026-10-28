/**
 * #2162 (cor:agt:050:27) — the closed vocabulary of a context reset: its phases, its refusal and failure reasons, and
 * the lease constants of the stop protocol. The database holds the same sets (prisma/context-reset-invariants.sql
 * `chk_context_resets_shape`); a test pins the two together.
 */

/** requested → claimed → checkpointed → stop-granted → agent-stopped → relaunched → done, or refused / failed. */
export const CONTEXT_RESET_PHASES = [
  'requested', 'claimed', 'checkpointed', 'stop-granted', 'agent-stopped', 'relaunched', 'done', 'refused', 'failed',
] as const;
export type ContextResetPhase = (typeof CONTEXT_RESET_PHASES)[number];

/** The phases in which the reset holds its claim: the worker carries its `resetting` mark. */
export const CLAIMED_PHASES = ['claimed', 'checkpointed', 'stop-granted', 'agent-stopped', 'relaunched'] as const;
/** The phases a cancellation ends (a relaunched reset only waits for its report). */
export const CANCELLABLE_PHASES = ['requested', 'claimed', 'checkpointed', 'stop-granted', 'agent-stopped'] as const;
export const ENDED_PHASES = ['done', 'refused', 'failed'] as const;

/** Why a reset was refused: it never reached process control, or the server refused it there. */
export const CONTEXT_RESET_REFUSALS = [
  'DIRTY_TREE', 'UNPUSHED_HEAD', 'BUSY', 'DRAFT_OR_MENU', 'TWO_AGENTS', 'SESSION_CHANGED', 'OTHER_WORK', 'UNAVAILABLE',
  'PAUSED', 'SETTING_OFF', 'NOT_IDLE', 'PROCESS_CHANGED', 'NO_RECOVERY_REF',
] as const;
/** Why a reset failed after it was taken, or could not be taken at all. */
export const CONTEXT_RESET_FAILURES = [
  'CHECKPOINT_FAILED', 'STAGING_FAILED', 'CLAIM_LAPSED', 'RELAUNCH_UNVERIFIED', 'RELAUNCH_BLOCKED', 'HOST_UNSUPPORTED',
  'HOST_LOST', 'REPORT_TIMEOUT', 'SESSION_ENDED', 'WORKER_GONE', 'CANCELLED_BY_CLEAR',
] as const;
export type ContextResetRefusal = (typeof CONTEXT_RESET_REFUSALS)[number];
export type ContextResetFailure = (typeof CONTEXT_RESET_FAILURES)[number];
export type ContextResetReason = ContextResetRefusal | ContextResetFailure;

export const isRefusal = (r: string): r is ContextResetRefusal => (CONTEXT_RESET_REFUSALS as readonly string[]).includes(r);
export const isFailure = (r: string): r is ContextResetFailure => (CONTEXT_RESET_FAILURES as readonly string[]).includes(r);

/** The reasons a HOST may name when it reports the operation FAILED (cor:agt:070:02), by the phase it stopped in. */
export const HOST_REPORTED_REASONS: readonly ContextResetReason[] = [
  'DIRTY_TREE', 'UNPUSHED_HEAD', 'BUSY', 'DRAFT_OR_MENU', 'TWO_AGENTS', 'NOT_IDLE', 'PROCESS_CHANGED',
  'CHECKPOINT_FAILED', 'STAGING_FAILED', 'RELAUNCH_UNVERIFIED', 'RELAUNCH_BLOCKED',
];
/** The reasons `relaunchFailed` takes: a failure after the claim that the host saw. */
export const RELAUNCH_FAILED_REASONS: readonly ContextResetFailure[] = [
  'CHECKPOINT_FAILED', 'STAGING_FAILED', 'RELAUNCH_UNVERIFIED', 'RELAUNCH_BLOCKED',
];

/** A claim not followed by a stop request within this long lapses (CLAIM_LAPSED). */
export const CLAIM_LEASE_MS = 5 * 60_000;
/** L: how long a granted stop may be acted on, counted by the host from BEFORE it sent the request. */
export const STOP_LEASE_MS = 15_000;
/** ρ: the bound on how much faster the host's clock may run than the server's. */
export const CLOCK_RATE_BOUND = 0.01;
/** m: the margin added before the server treats a granted stop as closed. */
export const RELEASE_MARGIN_MS = 5_000;

/**
 * The earliest instant the server may release a `resetting` fence after granting a stop at `grantedAt`
 * (the #2162 build boundary §2.2): `grantedAt + L·(1+ρ) + m`. The host's own deadline is `t0 + L` on CLOCK_BOOTTIME,
 * where `t0` precedes the request and so precedes `grantedAt`; whatever the network delay, the host's window closes no
 * later than `grantedAt + L` in real time, and the rate bound and margin cover its clock.
 */
export function stopLeaseEnd(grantedAt: Date, leaseMs: number): Date {
  return new Date(grantedAt.getTime() + Math.ceil(leaseMs * (1 + CLOCK_RATE_BOUND)) + RELEASE_MARGIN_MS);
}

/** The agent process a host observed: its pid and the kernel's start time for it (a token, never a path). */
export type ObservedProcess = { pid: number; startTime: string };
export const PROCESS_START_TIME_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
