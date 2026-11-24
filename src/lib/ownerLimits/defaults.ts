/**
 * The deployment's default owner limits, env `OWNER_DEFAULT_LIMITS` (#5009): JSON `{ "user": { "nodes": 2000 }, "organization": {} }`.
 * Unset or blank means no limits. Read once, at boot; a malformed value refuses boot and is never echoed.
 */
import type { OwnerType } from '../owner.js';
import { isSettableOwnerLimitKey, type OwnerLimitKey } from './keys.js';

export type OwnerDefaultLimits = Readonly<Record<OwnerType, ReadonlyMap<OwnerLimitKey, bigint>>>;

export const OWNER_DEFAULT_LIMITS_ERROR =
  'OWNER_DEFAULT_LIMITS must be a JSON object with the optional keys "user" and "organization", each an object of owner-limit keys to ' +
  'non-negative whole numbers; refusing to boot.';

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse the raw value, or throw the one fixed sentence (no part of the value, and no `cause`: a JSON parse error quotes its input). */
export function parseOwnerDefaultLimits(raw: string | undefined): OwnerDefaultLimits {
  const out = { user: new Map<OwnerLimitKey, bigint>(), organization: new Map<OwnerLimitKey, bigint>() };
  if (raw === undefined || raw.trim() === '') return out;
  const bad = () => new Error(OWNER_DEFAULT_LIMITS_ERROR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bad();
  }
  if (!isPlainObject(parsed)) throw bad();
  for (const [type, limits] of Object.entries(parsed)) {
    if ((type !== 'user' && type !== 'organization') || !isPlainObject(limits)) throw bad();
    for (const [key, value] of Object.entries(limits)) {
      if (!isSettableOwnerLimitKey(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw bad();
      out[type].set(key, BigInt(value));
    }
  }
  return out;
}

let loaded: OwnerDefaultLimits | undefined;

/** Parse and keep the defaults. Called by `createServer`, so a malformed value refuses boot. A refused value leaves the kept ones alone. */
export function loadOwnerDefaultLimits(env: NodeJS.ProcessEnv = process.env): void {
  loaded = parseOwnerDefaultLimits(env.OWNER_DEFAULT_LIMITS);
}

/** The default limit of a key for an owner type; null when there is none. Loads lazily for code that runs without `createServer`. */
export function ownerDefaultLimit(type: OwnerType, key: OwnerLimitKey): bigint | null {
  if (!loaded) loadOwnerDefaultLimits();
  return loaded![type].get(key) ?? null;
}

/** Tests set the defaults per case. */
export function reloadOwnerDefaultLimitsForTests(env: Record<string, string | undefined>): void {
  loadOwnerDefaultLimits(env as NodeJS.ProcessEnv);
}
