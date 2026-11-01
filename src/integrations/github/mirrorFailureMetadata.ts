/** #3057: diagnostic values are selected, never redacted from exception text. */
import type { MirrorErrorClass } from './mirrorObligations.js';
export type MirrorFailurePhase = 'token' | 'branch' | 'tree' | 'push' | 'lock' | 'restore' | 'sequence' | 'settle' | 'sweep' | 'git';
type DiagnosticClass = MirrorErrorClass | 'REMOTE_RESTORE' | 'ATTEMPT_SEQUENCE' | 'SETTLEMENT' | 'SWEEP' | 'GIT_COMMAND_FAILED';
const ALLOWED_ERROR_CODES = ['GIT_COMMAND_FAILED', 'EACCES', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'P2002', 'P2010', 'P2028', 'P2034', 'P2024', 'P1001', 'P1017'] as const;
type ProviderCode = typeof ALLOWED_ERROR_CODES[number];
// Prisma and our wrapper assign own names. Native Error names are inherited and intentionally not classified.
const ERROR_TYPES = ['GitCommandError', 'PrismaClientInitializationError',
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientRustPanicError', 'PrismaClientValidationError'] as const;
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'] as const;
export interface MirrorFailureMetadata {
  phase: MirrorFailurePhase;
  class: DiagnosticClass;
  exitCode?: number;
  httpStatus?: number;
  providerCode?: ProviderCode;
  errorType?: typeof ERROR_TYPES[number];
  signal?: typeof SIGNALS[number];
}

/** Own data properties only: no getters, conversion or prototype walk; throwing Proxy traps are contained. */
function ownDataProperty(error: unknown, key: string): unknown {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  try { return Object.getOwnPropertyDescriptor(error, key)?.value; } catch { return undefined; }
}
function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
/** Caller supplies the fixed phase/class. The thrown value can supply only bounded numeric or closed-enum fields. */
export function mirrorFailureMetadata(error: unknown, phase: MirrorFailurePhase, failureClass: DiagnosticClass): MirrorFailureMetadata {
  const result: MirrorFailureMetadata = { phase, class: failureClass };
  const code = ownDataProperty(error, 'code');
  const errorCode = ownDataProperty(error, 'errorCode');
  const providerCode = ownDataProperty(error, 'providerCode');
  const name = ownDataProperty(error, 'name');
  const signal = ownDataProperty(error, 'signal');
  const exitCode = ownDataProperty(error, 'exitCode');
  const status = ownDataProperty(error, 'status');
  const httpStatus = ownDataProperty(error, 'httpStatus');
  if (isBoundedInteger(exitCode, 0, 255)) result.exitCode = exitCode;
  else if (isBoundedInteger(code, 0, 255)) result.exitCode = code;
  if (isBoundedInteger(httpStatus, 100, 599)) result.httpStatus = httpStatus;
  else if (isBoundedInteger(status, 100, 599)) result.httpStatus = status;
  // Only the fixed Git wrapper marker gives its retained spawn code precedence over the native code.
  // Prisma initialization errors instead put their code in errorCode; the same closed set applies.
  if (code === 'GIT_COMMAND_FAILED' && typeof providerCode === 'string' && (ALLOWED_ERROR_CODES as readonly string[]).includes(providerCode)) result.providerCode = providerCode as ProviderCode;
  else if (typeof code === 'string' && (ALLOWED_ERROR_CODES as readonly string[]).includes(code)) result.providerCode = code as ProviderCode;
  else if (typeof errorCode === 'string' && (ALLOWED_ERROR_CODES as readonly string[]).includes(errorCode)) result.providerCode = errorCode as ProviderCode;
  if (typeof name === 'string' && (ERROR_TYPES as readonly string[]).includes(name)) result.errorType = name as typeof ERROR_TYPES[number];
  if (typeof signal === 'string' && (SIGNALS as readonly string[]).includes(signal)) result.signal = signal as typeof SIGNALS[number];
  return result;
}
