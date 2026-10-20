/** #2025 / cor:agt:080:05 — one cadence/window dial and App delivery settings.
 * Busy/stuck bounds and their strict relation are Proposed, approved to build
 * by the scoped #2025 gate; standby behavior is #2023's (standby.ts).
 */
import { GraphQLError } from 'graphql';
import { s7Available } from './s7Availability.js';
import type { Prisma } from '../../generated/prisma/index.js';

export const DELIVERY_BUSY_MIN_SECONDS = 1;
export const DELIVERY_BUSY_MAX_SECONDS = 86_400;
export const DELIVERY_STUCK_MIN_SECONDS = 1;
export const DELIVERY_STUCK_MAX_SECONDS = 604_800;
/** #2138 §3.2 — the channel-check settings: a period of at least a minute, OVERDUE after at least one missed period. */
export const DELIVERY_CHECK_PERIOD_MIN_SECONDS = 60;
export const DELIVERY_CHECK_PERIOD_MAX_SECONDS = 86_400;
export const DELIVERY_FAILED_CHECKS_MIN = 1;
export const DELIVERY_FAILED_CHECKS_MAX = 100;
export const DELIVERY_SETTINGS_SELECT = {
  tickerMinCadenceSeconds: true,
  deliveryBusyDelaySeconds: true,
  deliveryStuckWindowSeconds: true,
  deliveryStandbyEnabled: true,
  deliveryCheckPeriodSeconds: true,
  deliveryFailedChecksToOverdue: true,
} as const;
export type DeliverySettings = {
  batchWindowSeconds: number;
  busyDelaySeconds: number;
  stuckWindowSeconds: number;
  standbyEnabled: boolean;
  standbyEffective: boolean;
  /** #2138 §3.2: a worker with a task is expected to check its team channel every period (seconds). Default 600. */
  checkPeriodSeconds: number;
  /** #2138 §3.2: OVERDUE after this many missed periods (+5 minutes slack). At least 1. Default 2. */
  failedChecksToOverdue: number;
};
export type DeliverySettingsPatch = Partial<Pick<DeliverySettings,
  'batchWindowSeconds' | 'busyDelaySeconds' | 'stuckWindowSeconds' | 'standbyEnabled' | 'checkPeriodSeconds' | 'failedChecksToOverdue'>>;
const error = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...details } });

/** Both transports call this inside the deciding manager transaction; no unknown/null input is silently ignored. */
export function parseDeliverySettingsPatch(raw: unknown): DeliverySettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('BAD_USER_INPUT', 'input must be a settings object.');
  const allowed = ['batchWindowSeconds', 'busyDelaySeconds', 'stuckWindowSeconds', 'standbyEnabled', 'checkPeriodSeconds', 'failedChecksToOverdue'];
  for (const [field, value] of Object.entries(raw)) {
    if (!allowed.includes(field)) throw error('BAD_USER_INPUT', 'Unknown delivery setting.');
    if (value === null || value === undefined) throw error('BAD_USER_INPUT', `${field} cannot be null; omit it to preserve its value.`);
    if (field === 'standbyEnabled' && typeof value !== 'boolean') throw error('BAD_USER_INPUT', 'standbyEnabled must be a boolean.');
  }
  return raw as DeliverySettingsPatch;
}

/** Validate the final candidate, not just the changed scalar: neither settings writer can evade the relation. */
export function validateDeliverySettings(settings: DeliverySettings, patch: DeliverySettingsPatch): void {
  for (const [field, min, max] of [
    ['busyDelaySeconds', DELIVERY_BUSY_MIN_SECONDS, DELIVERY_BUSY_MAX_SECONDS],
    ['stuckWindowSeconds', DELIVERY_STUCK_MIN_SECONDS, DELIVERY_STUCK_MAX_SECONDS],
  ] as const) {
    const value = settings[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw error('DELIVERY_SETTINGS_OUT_OF_RANGE', `${field} must be a whole number of seconds from ${min} to ${max}.`, { field, min, max });
    }
  }
  for (const [field, min, max] of [
    ['checkPeriodSeconds', DELIVERY_CHECK_PERIOD_MIN_SECONDS, DELIVERY_CHECK_PERIOD_MAX_SECONDS],
    ['failedChecksToOverdue', DELIVERY_FAILED_CHECKS_MIN, DELIVERY_FAILED_CHECKS_MAX],
  ] as const) {
    const value = settings[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw error('DELIVERY_SETTINGS_OUT_OF_RANGE', `${field} must be a whole number from ${min} to ${max}.`, { field, min, max });
    }
  }
  if (settings.stuckWindowSeconds <= settings.busyDelaySeconds + settings.batchWindowSeconds) {
    throw error('DELIVERY_SETTINGS_CONFLICT', 'stuckWindowSeconds must be greater than busyDelaySeconds + the shared cadence floor (batchWindowSeconds / minCadenceSeconds).');
  }
  if (patch.standbyEnabled === true && !s7Available()) {
    throw error('DELIVERY_STANDBY_UNAVAILABLE', 'Standby cannot be enabled until standby delivery behavior is available (S7b).');
  }
}

/** Internal read seam for S1/S5, after their own authorization; public callers use the resolver gate. */
export async function loadDeliverySettings(db: Pick<Prisma.TransactionClient, 'app'>, appId: string): Promise<DeliverySettings> {
  const s = await db.app.findUniqueOrThrow({ where: { id: appId }, select: DELIVERY_SETTINGS_SELECT });
  return {
    batchWindowSeconds: s.tickerMinCadenceSeconds,
    busyDelaySeconds: s.deliveryBusyDelaySeconds,
    stuckWindowSeconds: s.deliveryStuckWindowSeconds,
    standbyEnabled: s.deliveryStandbyEnabled,
    standbyEffective: s7Available() && s.deliveryStandbyEnabled, // inert until S7b (s7Availability.ts)
    checkPeriodSeconds: s.deliveryCheckPeriodSeconds,
    failedChecksToOverdue: s.deliveryFailedChecksToOverdue,
  };
}
