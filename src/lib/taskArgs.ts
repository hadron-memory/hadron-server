/**
 * #317 — required task-argument validation, v1 (spec cor:dmo:060:11).
 *
 * A runnable task node may declare its arguments in `Node.data.args`, an object
 * of `name -> { data_type?, required?, default?, description? }`. The v1 rule
 * uses only what the spec text states and nothing it leaves open:
 *
 *  - an argument is REQUIRED when its declaration has `required === true` and no
 *    `default` key ("presence of a default implies required: false");
 *  - it is SATISFIED when the caller's `args` carries the key with a value that
 *    is not null (`''`, `0` and `false` are present);
 *  - undeclared arguments are never inspected (they MUST NOT be silently
 *    dropped, and a schema never gates what else a caller may pass);
 *  - `data_type` is not checked (CLI arguments arrive as strings), defaults are
 *    not filled in, and a `data.args` that is not a plain object, or an entry
 *    that is not an object, declares nothing.
 *
 * Pure: the one enforcement point is `Mutation.runTask`, which judges this AFTER
 * the caller's read access so an unreadable task discloses nothing of its schema.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The names of required, default-less arguments the caller did not supply, in declaration order. */
export function missingRequiredTaskArgs(nodeData: unknown, callerArgs: Record<string, unknown> | undefined): string[] {
  if (!isPlainObject(nodeData)) return [];
  const declared = nodeData.args;
  if (!isPlainObject(declared)) return [];
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!isPlainObject(spec)) continue;
    if (spec.required !== true) continue;
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) continue;
    const supplied = callerArgs !== undefined && Object.prototype.hasOwnProperty.call(callerArgs, name) && callerArgs[name] != null;
    if (!supplied) missing.push(name);
  }
  return missing;
}
