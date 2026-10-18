/** #2025 / cor:agt:080:05 — one cadence/window dial and App delivery settings.
 * Busy/stuck bounds and their strict relation are Proposed, approved to build
 * by the scoped #2025 gate; standby behavior belongs to #2023, not this slice.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';

export const DELIVERY_BUSY_MIN_SECONDS = 1;
export const DELIVERY_BUSY_MAX_SECONDS = 86_400;
export const DELIVERY_STUCK_MIN_SECONDS = 1;
export const DELIVERY_STUCK_MAX_SECONDS = 604_800;
export const DELIVERY_SETTINGS_SELECT = {
  tickerMinCadenceSeconds: true,
  deliveryBusyDelaySeconds: true,
  deliveryStuckWindowSeconds: true,
  deliveryStandbyEnabled: true,
} as const;
export type DeliverySettings = {
  batchWindowSeconds: number;
  busyDelaySeconds: number;
  stuckWindowSeconds: number;
  standbyEnabled: boolean;
  standbyEffective: boolean;
};
export type DeliverySettingsPatch = Partial<Pick<DeliverySettings,
  'batchWindowSeconds' | 'busyDelaySeconds' | 'stuckWindowSeconds' | 'standbyEnabled'>>;
const error = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...details } });

/** Both transports call this inside the deciding manager transaction; no unknown/null input is silently ignored. */
export function parseDeliverySettingsPatch(raw: unknown): DeliverySettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('BAD_USER_INPUT', 'input must be a settings object.');
  const allowed = ['batchWindowSeconds', 'busyDelaySeconds', 'stuckWindowSeconds', 'standbyEnabled'];
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
  if (settings.stuckWindowSeconds <= settings.busyDelaySeconds + settings.batchWindowSeconds) {
    throw error('DELIVERY_SETTINGS_CONFLICT', 'stuckWindowSeconds must be greater than busyDelaySeconds + the shared cadence floor (batchWindowSeconds / minCadenceSeconds).');
  }
  if (patch.standbyEnabled === true) {
    throw error('DELIVERY_STANDBY_UNAVAILABLE', 'Standby cannot be enabled until standby delivery behavior is available (S7).');
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
    standbyEffective: false, // #2023 owns activation and filtering. Configuration alone never enables behavior.
  };
}
