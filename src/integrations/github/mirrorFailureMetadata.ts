/** #3057: diagnostic values are selected, never redacted from exception text. */
import type { MirrorErrorClass } from './mirrorObligations.js';
export type MirrorFailurePhase = 'token' | 'branch' | 'tree' | 'push' | 'lock' | 'restore' | 'sequence' | 'settle' | 'sweep' | 'git';
type DiagnosticClass = MirrorErrorClass | 'REMOTE_RESTORE' | 'ATTEMPT_SEQUENCE' | 'SETTLEMENT' | 'SWEEP' | 'GIT_COMMAND_FAILED';
const PROVIDER_CODES = ['GIT_COMMAND_FAILED', 'EACCES', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'P2002', 'P2010', 'P2028'] as const;
type ProviderCode = typeof PROVIDER_CODES[number];
export interface MirrorFailureMetadata {
  phase: MirrorFailurePhase;
  class: DiagnosticClass;
  exitCode?: number;
  httpStatus?: number;
  providerCode?: ProviderCode;
}

/** Only own data properties: no getters, string conversion, prototypes, cause or recursive inspection. */
function data(error: unknown, key: string): unknown {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  try { return Object.getOwnPropertyDescriptor(error, key)?.value; } catch { return undefined; }
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
/** Caller supplies the fixed phase/class. The thrown value can supply only bounded numeric or closed-enum fields. */
export function mirrorFailureMetadata(error: unknown, phase: MirrorFailurePhase, failureClass: DiagnosticClass): MirrorFailureMetadata {
  const result: MirrorFailureMetadata = { phase, class: failureClass };
  const code = data(error, 'code');
  const exitCode = data(error, 'exitCode');
  const status = data(error, 'status');
  const httpStatus = data(error, 'httpStatus');
  if (integer(exitCode, 0, 255)) result.exitCode = exitCode;
  else if (integer(code, 0, 255)) result.exitCode = code;
  if (integer(httpStatus, 100, 599)) result.httpStatus = httpStatus;
  else if (integer(status, 100, 599)) result.httpStatus = status;
  if (typeof code === 'string' && (PROVIDER_CODES as readonly string[]).includes(code)) result.providerCode = code as ProviderCode;
  return result;
}
