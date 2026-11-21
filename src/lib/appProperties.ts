/**
 * #3125 S1 — an App's own `properties` (cor:dmo:050:02, cor:dmo:050:20).
 *
 * The object is the team's: every key is stored and returned as given, and is never matcher or authorization input.
 * #4085 retired the task-integration namespace the platform once read inside it (cor:agt:120:01): `taskIntegrations`
 * is now an ordinary key, kept as written and never validated.
 *
 * The write rules, judged in this order after the manager gate (so a caller who doesn't manage the App gets the
 * same refusal whatever the object holds):
 *   1. a JSON object (or null to clear)                         → PROPERTIES_NOT_AN_OBJECT
 *   2. at most 64 levels deep and 16 KiB of canonical JSON      → PROPERTIES_TOO_LARGE (names the path)
 *   2a. no key named `__proto__`, at any depth                  → PROPERTIES_KEY_RESERVED (names the path)
 * A refusal names a JSON path, never a value (V47).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { canonicalJson } from './agentTasks/properties.js';

export const APP_PROPERTIES_MAX_BYTES = 16 * 1024;
export const APP_PROPERTIES_MAX_DEPTH = 64;

const refusal = (code: string, message: string, path?: string) =>
  new GraphQLError(message, { extensions: path === undefined ? { code } : { code, path } });

/** The path of the first value nested deeper than `max` levels, found without recursion; null when none is. */
function tooDeepPath(value: object, max: number): string | null {
  const stack: Array<[object, number, string]> = [[value, 1, '']];
  while (stack.length > 0) {
    const [node, depth, path] = stack.pop() as [object, number, string];
    if (depth > max) return path;
    for (const [k, child] of Object.entries(node)) {
      if (child !== null && typeof child === 'object') {
        const at = Array.isArray(node) ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`;
        stack.push([child, depth + 1, at]);
      }
    }
  }
  return null;
}

/**
 * The path of the first object key named `__proto__`, at any depth; null when none is. PR #3131 blind P2: the Prisma
 * JSON writer drops such an own key, so the row would silently store something other than what was sent (and a
 * write of `{"__proto__": ...}` would bump the revision for an unchanged `{}`). Refused instead of stored lossily.
 */
function reservedKeyPath(value: object): string | null {
  const stack: Array<[object, string]> = [[value, '']];
  while (stack.length > 0) {
    const [node, path] = stack.pop() as [object, string];
    for (const k of Object.keys(node)) {
      const at = Array.isArray(node) ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`;
      if (!Array.isArray(node) && k === '__proto__') return at;
      const child = (node as Record<string, unknown>)[k];
      if (child !== null && typeof child === 'object') stack.push([child, at]);
    }
  }
  return null;
}

/** Checks 1, 2 and 2a. */
export function checkAppPropertiesShape(value: unknown): Prisma.InputJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw refusal('PROPERTIES_NOT_AN_OBJECT', 'properties must be a JSON object (or null to clear them).');
  }
  const deep = tooDeepPath(value, APP_PROPERTIES_MAX_DEPTH);
  if (deep !== null) {
    throw refusal('PROPERTIES_TOO_LARGE', `properties.${deep} nests deeper than ${APP_PROPERTIES_MAX_DEPTH} levels.`, deep);
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > APP_PROPERTIES_MAX_BYTES) {
    throw refusal('PROPERTIES_TOO_LARGE', `properties may hold at most ${APP_PROPERTIES_MAX_BYTES} bytes of JSON.`, '');
  }
  const reserved = reservedKeyPath(value);
  if (reserved !== null) {
    throw refusal('PROPERTIES_KEY_RESERVED', `properties.${reserved}: the key __proto__ cannot be stored. Nothing was changed.`, reserved);
  }
  return value as Prisma.InputJsonObject;
}

/**
 * The top-level keys whose value differs between two objects (null = none), sorted. Values never leave here.
 * OWN keys only (PR #3131 blind P2): `in` and a plain lookup see Object.prototype, so a JSON key named `__proto__`
 * would read as present on an empty object and its write or removal would be dropped as a no-op.
 */
export function changedTopLevelKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const a = before ?? {}, b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((k) => !Object.hasOwn(a, k) || !Object.hasOwn(b, k) || canonicalJson(a[k]) !== canonicalJson(b[k]))
    .sort();
}
