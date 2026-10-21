/** Types for the #2163 part 2 reminder hook, so its decision logic is unit-tested from TypeScript without a build. */
export const FLOOR_TOKENS: number;
export const THRESHOLDS: ReadonlyArray<readonly [string, number]>;
export const ESCALATION_TOKENS: number;
export const HYSTERESIS_TOKENS: number;
export const MAX_FIRES: number;
export const FRESHNESS_MS: number;
export const FUTURE_SKEW_MS: number;
export const TAIL_BYTES: number;
export const STDIN_MAX_BYTES: number;
export const STATE_MAX_AGE_MS: number;
export const STATE_MAX_FILES: number;
export const LOG_MAX_BYTES: number;
export const LOCK_WAIT_MS: number;
export const LOCK_STALE_MS: number;
export const REMINDER_TEXT: (reclaimableK: number, thresholdK: number) => string;
export function thresholdFor(model: unknown): number | null;
export interface Arm {
  fires: number;
  atReclaimable: number | null;
  firedThreshold: number | null;
  lastBoundary: string | null;
  lastReclaimable: number;
  updatedAt: number;
}
export function scanTail(text: string, startedAtBeginning: boolean): {
  assistant: { idx: number; ts: unknown; model: unknown; input: unknown; read: unknown; create: unknown } | null;
  boundary: { idx: number; ts: unknown; uuid: unknown; postTokens: unknown } | null;
};
export function observe(scan: ReturnType<typeof scanTail>, now: number):
  | { skip: string }
  | { occupied: number; model: string; boundaryId: string | null; skip?: undefined };
export function decide(state: Partial<Arm> | null, obs: { occupied: number; model: string; boundaryId: string | null }, now: number):
  { next: Arm; fire: boolean; reclaimable: number; threshold: number };
export function vetTranscript(path: unknown, env: Record<string, string | undefined>, uid?: number): string | null;
export function run(stdin: unknown, env: Record<string, string | undefined>, opts?: { now?: number; uid?: number; nowMs?: () => number }): string | null;
