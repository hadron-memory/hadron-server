/**
 * Object-store sugar layer (#745) — pure mapping helpers.
 *
 * The object API (`createObject` / `getObject` / `updateObject` / `deleteObject`
 * / `findObjects`) is a thin, legible **projection** over the #719/#725
 * structured-storage substrate: an object IS a node. This module holds the pure,
 * DB-free transforms the resolvers (and later the MCP tools) share:
 *
 *  - project a node → a flat object `{ id, type, ...fields }` (id/type reserved),
 *  - derive a node loc + name for a new object (loc/name are hidden ceremony),
 *  - desugar the `match` equality shorthand → a `where` predicate and the `sort`
 *    shorthand → a `sortProperty`, inferring each field's cast from the memory
 *    schema so `match: { fundingUsd: 1e7 }` compares numerically.
 *
 * Design decision + rationale: `hadron-server::design:object-store-api`.
 */
import type { NodeWhere, NodePropertySort, PredicateCast, SortDirection } from './retrieval/nodeWhere.js';
import type { MemorySchema } from './memorySchema.js';

/** Reserved envelope keys — an object field can't be named these (they'd collide with the projection). */
export const RESERVED_OBJECT_KEYS = ['id', 'type'] as const;

/** Thrown on malformed object input; the resolver maps it to BAD_USER_INPUT. */
export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

/** The flat object shape the API returns: the reserved envelope plus the node's properties. */
export type StoredObject = Record<string, unknown> & { id: string; type: string | null };

/** A node's fields needed to project it to a flat object. */
export interface ProjectableNode {
  id: string;
  objectType: string | null;
  properties: unknown;
}

/**
 * Flatten a node to a flat object `{ id, type, ...fields }`. `id` is the node's
 * stable PK (the object's addressing handle); `type` is the collection
 * (`objectType`). The node's `properties` become top-level fields — reads like a
 * database row / document, not a graph node.
 */
export function projectNodeToObject(node: ProjectableNode): StoredObject {
  const props =
    node.properties != null && typeof node.properties === 'object' && !Array.isArray(node.properties)
      ? (node.properties as Record<string, unknown>)
      : {};
  return { ...props, id: node.id, type: node.objectType };
}

/** Reject reserved keys (`id`/`type`) in an object's fields — they can't be field names. */
export function assertNoReservedKeys(fields: Record<string, unknown>): void {
  for (const k of RESERVED_OBJECT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      throw new ObjectStoreError(`"${k}" is a reserved object key and cannot be used as a field name`);
    }
  }
}

/** True for a plain (non-array) JSON object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Derive the node loc for a NEW object: `<type>:<key ?? generatedId>`. The loc is
 * hidden from the caller (they address by the opaque `id`); an optional natural
 * `key` yields a human-meaningful loc (e.g. `competitor:letta`). The resulting
 * loc is validated downstream by the node write seam (`validateLoc`), so an
 * unsafe `type`/`key` surfaces as a typed error there.
 */
export function deriveObjectLoc(type: string, key: string | undefined, genId: () => string): string {
  // `type` and `key` each become a SINGLE loc segment. A ':' (the loc hierarchy
  // delimiter) would inject extra segments — making one object a descendant of
  // another (e.g. key "a" → "type:a", key "a:b" → "type:a:b"), which then can't
  // be deleted through the flat object API (deleteObject is non-recursive, and
  // deleteNode refuses NODE_HAS_DESCENDANTS). Reject it here; validateLoc handles
  // the rest of the charset downstream.
  const t = type.trim();
  if (t.includes(':')) {
    throw new ObjectStoreError(`type must be a single segment (no ":"): ${JSON.stringify(type)}`);
  }
  const trimmed = key != null ? key.trim() : '';
  if (trimmed !== '' && trimmed.includes(':')) {
    throw new ObjectStoreError(`key must be a single segment (no ":"): ${JSON.stringify(key)}`);
  }
  return `${t}:${trimmed !== '' ? trimmed : genId()}`;
}

/**
 * Derive the node name for a NEW object (nodes require a name; objects hide it).
 * Precedence: explicit `name` → a `name`/`title` string field → the collection
 * type. (A schema-designated title field is a future refinement.)
 */
export function deriveObjectName(type: string, fields: Record<string, unknown>, explicitName?: string): string {
  if (typeof explicitName === 'string' && explicitName.trim() !== '') return explicitName.trim();
  for (const cand of ['name', 'title']) {
    const v = fields[cand];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return type;
}

/**
 * The where/sort cast for a collection field: the schema's declared type when
 * known (enum → text), else — for a `match` value — infer number/boolean from
 * the JS value, else text. datetime is only ever inferred from the schema (a
 * date string is indistinguishable from text without one).
 */
export function castForField(
  schema: MemorySchema | null | undefined,
  type: string,
  field: string,
  sampleValue?: unknown,
): PredicateCast {
  const ft = schema?.objectTypes?.[type]?.fields?.[field]?.type;
  if (ft === 'number' || ft === 'datetime' || ft === 'boolean') return ft;
  if (ft === 'enum' || ft === 'text') return 'text';
  // No schema (or field undeclared) → infer from the value where unambiguous.
  if (typeof sampleValue === 'number') return 'number';
  if (typeof sampleValue === 'boolean') return 'boolean';
  return 'text';
}

/**
 * Desugar a `match` equality map into a `where` predicate — an AND of `eq`
 * leaves, each cast per {@link castForField}. Returns null for an empty match.
 */
export function matchToWhere(
  match: Record<string, unknown> | null | undefined,
  type: string,
  schema: MemorySchema | null | undefined,
): NodeWhere | null {
  if (match == null) return null;
  if (!isPlainObject(match)) throw new ObjectStoreError('match must be a JSON object of field → value equality pairs');
  const keys = Object.keys(match);
  if (keys.length === 0) return null;
  const leaves: NodeWhere[] = keys.map((k) => ({
    path: [k],
    as: castForField(schema, type, k, match[k]),
    eq: match[k],
  }));
  return leaves.length === 1 ? leaves[0] : { and: leaves };
}

/** Combine an optional desugared `match` predicate with an optional explicit `where` (AND). */
export function combineWhere(matchWhere: NodeWhere | null, where: NodeWhere | null | undefined): NodeWhere | undefined {
  if (matchWhere && where) return { and: [matchWhere, where] };
  return matchWhere ?? where ?? undefined;
}

/**
 * Desugar a `sort` shorthand `{ field: "asc" | "desc" }` into a `sortProperty`,
 * the field's cast inferred from the schema. Single field for v1. Returns
 * undefined for an empty sort.
 */
export function sortToPropertySort(
  sort: Record<string, unknown> | null | undefined,
  type: string,
  schema: MemorySchema | null | undefined,
): NodePropertySort | undefined {
  if (sort == null) return undefined;
  if (!isPlainObject(sort)) throw new ObjectStoreError('sort must be a JSON object, e.g. { fundingUsd: "desc" }');
  const keys = Object.keys(sort);
  if (keys.length === 0) return undefined;
  if (keys.length > 1) {
    throw new ObjectStoreError('sort accepts a single field for now, e.g. { fundingUsd: "desc" }');
  }
  const field = keys[0];
  const dir = sort[field];
  if (dir !== 'asc' && dir !== 'desc') {
    throw new ObjectStoreError(`sort direction must be "asc" or "desc" (got ${JSON.stringify(dir)})`);
  }
  return { path: [field], as: castForField(schema, type, field), direction: dir as SortDirection };
}
