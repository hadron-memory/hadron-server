/**
 * Memory property schema (#725 — structured storage, PR B).
 *
 * A per-memory, opt-in declaration of the collections (object types) a memory
 * holds and the typed fields each carries — the schema half of "Hadron as a
 * very simple document store". Stored on `Memory.schema` (a dedicated JSONB
 * column) and authored via GraphQL/portal (`updateMemory`). This module owns the
 * SHAPE contract + a well-formedness validator so a garbage schema can't be
 * saved; it does NOT validate node `properties` against the schema (that is the
 * enforcement phase, PR C) — until then a node's `objectType` is free-form.
 *
 * Shape (see validateMemorySchema):
 *   {
 *     "objectTypes": {
 *       "competitor": {
 *         "description": "...",         // optional
 *         "strict": false,             // optional (default false; PR C: reject unknown keys)
 *         "fields": {
 *           "name":      { "type": "text", "required": true },
 *           "stage":     { "type": "enum", "values": ["seed","series-a"] },
 *           "firstSeen": { "type": "datetime" }
 *         }
 *       }
 *     }
 *   }
 *
 * The field `type` vocabulary is the #719 `where`-cast set + `enum`, so a
 * declared field type IS its query cast.
 */

/** Field value type. Mirrors the #719 predicate casts, plus enum. */
export type MemorySchemaFieldType = 'text' | 'number' | 'datetime' | 'boolean' | 'enum';

export interface MemorySchemaField {
  type: MemorySchemaFieldType;
  required?: boolean;
  /** Allowed values — required (non-empty) for `enum`, forbidden otherwise. */
  values?: string[];
  description?: string;
}

export interface MemorySchemaObjectType {
  fields: Record<string, MemorySchemaField>;
  /** When true, a node of this collection may carry ONLY declared fields (enforced in PR C). Default false. */
  strict?: boolean;
  description?: string;
}

export interface MemorySchema {
  objectTypes: Record<string, MemorySchemaObjectType>;
}

/** Thrown on a malformed schema; the resolver maps it to BAD_USER_INPUT. */
export class MemorySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemorySchemaError';
  }
}

const FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'datetime', 'boolean', 'enum']);
/** Collection + field names are identifier-like (queryable, git-safe, portal-safe). */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// A rich schema is still a bounded one (defense-in-depth, like the where caps).
export const SCHEMA_MAX_OBJECT_TYPES = 200;
export const SCHEMA_MAX_FIELDS = 200;
export const SCHEMA_MAX_ENUM_VALUES = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reject any key not in `allowed` — catches typos (e.g. `requird`) at author time. */
function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new MemorySchemaError(`unknown key "${k}" in ${where} (allowed: ${allowed.join(', ')})`);
  }
}

function validateField(name: string, raw: unknown): MemorySchemaField {
  if (!NAME_RE.test(name)) {
    throw new MemorySchemaError(`invalid field name "${name}" (allowed: [A-Za-z0-9_-], 1-64 chars)`);
  }
  if (!isPlainObject(raw)) throw new MemorySchemaError(`field "${name}" must be an object`);
  assertNoUnknownKeys(raw, ['type', 'required', 'values', 'description'], `field "${name}"`);

  const { type, required, values, description } = raw;
  if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
    throw new MemorySchemaError(`field "${name}".type must be one of ${[...FIELD_TYPES].join(' | ')}`);
  }
  if (required !== undefined && typeof required !== 'boolean') {
    throw new MemorySchemaError(`field "${name}".required must be a boolean`);
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new MemorySchemaError(`field "${name}".description must be a string`);
  }
  const field: MemorySchemaField = { type: type as MemorySchemaFieldType };
  if (required !== undefined) field.required = required;
  if (description !== undefined) field.description = description;

  if (type === 'enum') {
    if (!Array.isArray(values) || values.length === 0) {
      throw new MemorySchemaError(`field "${name}" (enum) requires a non-empty "values" array`);
    }
    if (values.length > SCHEMA_MAX_ENUM_VALUES) {
      throw new MemorySchemaError(`field "${name}".values exceeds max ${SCHEMA_MAX_ENUM_VALUES}`);
    }
    if (!values.every((v) => typeof v === 'string')) {
      throw new MemorySchemaError(`field "${name}".values must be an array of strings`);
    }
    field.values = values as string[];
  } else if (values !== undefined) {
    throw new MemorySchemaError(`field "${name}".values is only valid for type "enum"`);
  }
  return field;
}

function validateObjectType(name: string, raw: unknown): MemorySchemaObjectType {
  if (!NAME_RE.test(name)) {
    throw new MemorySchemaError(`invalid object type name "${name}" (allowed: [A-Za-z0-9_-], 1-64 chars)`);
  }
  if (!isPlainObject(raw)) throw new MemorySchemaError(`object type "${name}" must be an object`);
  assertNoUnknownKeys(raw, ['fields', 'strict', 'description'], `object type "${name}"`);

  const { fields, strict, description } = raw;
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    throw new MemorySchemaError(`object type "${name}" requires a non-empty "fields" object`);
  }
  const fieldNames = Object.keys(fields);
  if (fieldNames.length > SCHEMA_MAX_FIELDS) {
    throw new MemorySchemaError(`object type "${name}" exceeds max ${SCHEMA_MAX_FIELDS} fields`);
  }
  if (strict !== undefined && typeof strict !== 'boolean') {
    throw new MemorySchemaError(`object type "${name}".strict must be a boolean`);
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new MemorySchemaError(`object type "${name}".description must be a string`);
  }
  const out: MemorySchemaObjectType = {
    fields: Object.fromEntries(fieldNames.map((fn) => [fn, validateField(fn, fields[fn])])),
  };
  if (strict !== undefined) out.strict = strict;
  if (description !== undefined) out.description = description;
  return out;
}

/**
 * Validate + normalize a memory schema. Returns the cleaned schema (unknown keys
 * rejected, so what's stored is exactly the contract). Throws MemorySchemaError
 * on any malformed input.
 */
export function validateMemorySchema(input: unknown): MemorySchema {
  if (!isPlainObject(input)) throw new MemorySchemaError('schema must be an object');
  assertNoUnknownKeys(input, ['objectTypes'], 'schema');
  const { objectTypes } = input;
  if (!isPlainObject(objectTypes) || Object.keys(objectTypes).length === 0) {
    throw new MemorySchemaError('schema requires a non-empty "objectTypes" object');
  }
  const names = Object.keys(objectTypes);
  if (names.length > SCHEMA_MAX_OBJECT_TYPES) {
    throw new MemorySchemaError(`schema exceeds max ${SCHEMA_MAX_OBJECT_TYPES} object types`);
  }
  return {
    objectTypes: Object.fromEntries(names.map((n) => [n, validateObjectType(n, objectTypes[n])])),
  };
}
