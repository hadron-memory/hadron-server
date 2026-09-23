/**
 * #1227 — how a properties PATCH lands on a node's `properties.exports`.
 *
 * `updateNodeProperties` merges one level: a patch key replaces the stored
 * value whole. That was right for a flat bag, and D12 then made `exports` a
 * NESTED object keyed by host — so a client writing one host's declaration
 * (`{exports: {codexSkill: {...}}}`) replaced the whole `exports` value and
 * silently deleted every sibling host. Each change was correct alone; they did
 * not compose.
 *
 * Ruled (Holger, 2026-09-23): under `exports` ONLY, the patch applies as a
 * JSON Merge Patch (RFC 7396) — objects merge recursively, `null` DELETES,
 * anything else (scalars, arrays) replaces. So:
 *
 *   {exports: {codexSkill: {enable: false}}}   flips one flag, keeps the rest
 *   {exports: {codexSkill: null}}              removes that host
 *
 * Every other top-level key keeps the shallow, patch-wins merge it always had:
 * this is a rule about the one key whose shape is nested by contract, not a
 * change of merge semantics for the whole bag.
 *
 * Why the server and not the client: the merge runs under the per-node
 * advisory lock `updateNodeProperties` already takes, so two clients toggling
 * DIFFERENT hosts at once both land. A client read-modify-write of `exports`
 * would lose one of them — the #746 race, reintroduced one level down.
 */
import { EXPORTS_KEY } from './declaration.js';

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * RFC 7396 MergePatch(target, patch). Pure: neither argument is mutated.
 *
 * A non-object patch replaces the target (arrays included — RFC 7396 has no
 * array merge). An object patch applies onto the target, or onto `{}` when the
 * target is not an object; a `null` member deletes that key, and a key it
 * deletes that was never there is a no-op.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: JsonObject = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      // Read OWN, write as an own DATA property — never `result[key] = …`.
      // A key literally named `__proto__` is ordinary data here (JSON.parse
      // makes it an own key, and the declaration reader accepts it as a host
      // name), but bracket assignment of a NEW `__proto__` key invokes the
      // inherited setter: the host vanishes from the serialized result and
      // the object's prototype changes (#1278 review, Copilot + Codex).
      const current = Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined;
      Object.defineProperty(result, key, {
        value: mergePatch(current, value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}

/**
 * The full `updateNodeProperties` merge: shallow, patch-wins at the top level,
 * except that an OBJECT patch for `exports` is merge-patched into the stored
 * `exports` (see the module header).
 *
 * A non-object `exports` in the patch (`null`, a scalar, an array) keeps the
 * top-level semantics and replaces the stored value — so `{exports: null}`
 * still sets `exports: null` exactly as it did before #1227. Only the shape
 * the contract defines (an object keyed by host) gains depth.
 *
 * `existing` that is not an object (no properties yet) takes the patch as-is,
 * with `exports` still normalized through the merge so a first write cannot
 * store the `null` members that mean "delete".
 */
export function mergePropertiesPatch(existing: unknown, patch: JsonObject): JsonObject {
  const base: JsonObject = isPlainObject(existing) ? existing : {};
  const merged: JsonObject = { ...base, ...patch };
  if (isPlainObject(patch[EXPORTS_KEY])) {
    merged[EXPORTS_KEY] = mergePatch(base[EXPORTS_KEY], patch[EXPORTS_KEY]);
  }
  return merged;
}
