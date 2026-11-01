import { createHash } from 'node:crypto';

export const RATE_CLASSES = ['CREDENTIALS', 'OUTBOUND', 'WRITES', 'FAN_OUT_READS', 'OTHER_READS'] as const;
export type FieldClass = typeof RATE_CLASSES[number];
export type EnforcementMode = 'LOG_ONLY' | 'ENFORCING';
export const DEFAULTS: Record<FieldClass, { windowSeconds: number; principalLimit: number; keyLimit: number; ipLimit: number }> = {
  CREDENTIALS: { windowSeconds: 900, principalLimit: 30, keyLimit: 30, ipLimit: 60 },
  OUTBOUND: { windowSeconds: 3600, principalLimit: 60, keyLimit: 60, ipLimit: 120 },
  WRITES: { windowSeconds: 60, principalLimit: 600, keyLimit: 300, ipLimit: 1200 },
  FAN_OUT_READS: { windowSeconds: 60, principalLimit: 300, keyLimit: 120, ipLimit: 600 },
  OTHER_READS: { windowSeconds: 60, principalLimit: 1200, keyLimit: 600, ipLimit: 2400 },
};
export class RateConfigurationError extends Error {
  constructor() { super('Rate limiter configuration is invalid; serving readiness refused.'); }
}
export function readRateKeys(env = process.env): { current: string; keys: Map<string, Buffer> } {
  try {
    const value = JSON.parse(env.RATE_LIMIT_KEYRING ?? '');
    if (!value || typeof value.current !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.current) || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw 0;
    const entries = Object.entries(value.keys);
    if (entries.length < 1 || entries.length > 2) throw 0;
    const keys = new Map<string, Buffer>();
    for (const [id, key] of entries) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw 0;
      keys.set(id, Buffer.from(key, 'hex'));
    }
    if (!keys.has(value.current)) throw 0;
    return { current: value.current, keys };
  } catch { throw new RateConfigurationError(); }
}
export function keyFingerprint(key: Buffer): string { return createHash('sha256').update(key).digest('hex'); }
export function seedLimits(fieldClass: FieldClass) {
  const defaults = DEFAULTS[fieldClass];
  const limits = { ...defaults };
  for (const dim of ['principal', 'key', 'ip'] as const) {
    const raw = process.env[`RATE_LIMIT_${fieldClass}_${dim.toUpperCase()}`];
    if (raw !== undefined) {
      if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 2147483647) throw new RateConfigurationError();
      limits[`${dim}Limit`] = Number(raw);
    }
  }
  return limits;
}
