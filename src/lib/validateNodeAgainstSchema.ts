/**
 * Node-vs-schema enforcement (#725 PR C1 — the enforcement phase).
 *
 * Validates a node's `objectType` + `properties` against its memory's declared
 * property schema (Memory.schema, shape owned by src/lib/memorySchema.ts). Called
 * on EVERY node write (the GraphQL writeNodeCore path + the MCP create/update
 * tools) so a structured record can't be written in violation of its collection.
 *
 * Contract (schema-on-write; the design's "strict for new writes, never
 * retro-invalidates"):
 *  - No schema on the memory       → no enforcement (objectType stays free-form).
 *  - objectType null/unset         → not a collection member; no property check.
 *  - objectType set + schema present:
 *      • objectType MUST name a declared collection (else violation).
 *      • every `required` field must be present (non-null).
 *      • a present field's value must be COERCIBLE to its declared type —
 *        matching the #719 where-cast semantics, so a value that validates here
 *        is also queryable (e.g. "0.9" satisfies a `number` field).
 *      • a `strict` collection additionally rejects any undeclared property key.
 *
 * A violation throws NodeSchemaViolation, which the write surfaces map to
 * BAD_USER_INPUT. Pre-existing non-conforming nodes are audited on demand by the
 * conformance check (PR C2), never rejected retroactively.
 */
import type { MemorySchema, MemorySchemaField } from './memorySchema.js';

export class NodeSchemaViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeSchemaViolation';
  }
}

/** Is a present (non-null) property value coercible to the declared field type? */
export function valueMatchesFieldType(field: MemorySchemaField, value: unknown): boolean {
  switch (field.type) {
    case 'text':
      // Coercible-to-text, matching #719 asText (string | finite number | boolean
      // all stringify and stay queryable as text).
      return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false';
    case 'number':
      return typeof value === 'number'
        ? Number.isFinite(value)
        : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    case 'datetime':
      return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
    case 'enum':
      return typeof value === 'string' && (field.values ?? []).includes(value);
    default:
      return false;
  }
}

/**
 * Throw NodeSchemaViolation if the node's objectType/properties violate the
 * memory schema. A no-op when the memory has no schema or the node has no
 * objectType.
 */
export function validateNodeAgainstSchema(
  schema: MemorySchema | null | undefined,
  objectType: string | null | undefined,
  properties: Record<string, unknown> | null | undefined,
): void {
  if (schema == null) return; // unschema'd memory → free-form
  if (objectType == null) return; // not a collection member (an empty string is normalized to null on write)

  const def = Object.prototype.hasOwnProperty.call(schema.objectTypes ?? {}, objectType)
    ? schema.objectTypes[objectType]
    : undefined;
  if (!def) {
    const declared = Object.keys(schema.objectTypes ?? {}).join(', ') || 'none';
    throw new NodeSchemaViolation(
      `objectType "${objectType}" is not a declared collection in this memory's schema (declared: ${declared})`,
    );
  }

  // A collection member's `properties` must be a plain object (GraphQL allows
  // scalar/array JSON there generally, but a schema'd record needs object fields).
  if (properties != null && (typeof properties !== 'object' || Array.isArray(properties))) {
    throw new NodeSchemaViolation(`objectType "${objectType}": properties must be an object`);
  }
  const props: Record<string, unknown> = properties ?? {};
  for (const [name, field] of Object.entries(def.fields)) {
    const present = Object.prototype.hasOwnProperty.call(props, name) && props[name] != null;
    if (!present) {
      if (field.required) {
        throw new NodeSchemaViolation(`objectType "${objectType}": required field "${name}" is missing`);
      }
      continue;
    }
    if (!valueMatchesFieldType(field, props[name])) {
      const suffix = field.type === 'enum' ? ` (one of: ${(field.values ?? []).join(', ')})` : '';
      throw new NodeSchemaViolation(`objectType "${objectType}": field "${name}" must be ${field.type}${suffix}`);
    }
  }

  if (def.strict) {
    for (const key of Object.keys(props)) {
      // own-property check — `in` would let inherited keys (toString, …) slip past.
      if (!Object.prototype.hasOwnProperty.call(def.fields, key)) {
        throw new NodeSchemaViolation(`objectType "${objectType}" is strict — unknown property "${key}"`);
      }
    }
  }
}
