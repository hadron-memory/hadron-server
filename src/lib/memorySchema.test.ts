/**
 * Unit tests for the Memory property-schema well-formedness validator (#725 PR B).
 * Pure — no DB. Pins the shape contract and the rejection of malformed schemas.
 */
import { describe, it, expect } from 'vitest';
import { validateMemorySchema, MemorySchemaError, SCHEMA_MAX_ENUM_VALUES } from './memorySchema.js';

const ok = {
  objectTypes: {
    competitor: {
      description: 'A tracked company/product',
      strict: false,
      fields: {
        name: { type: 'text', required: true },
        stage: { type: 'enum', values: ['seed', 'series-a', 'growth'] },
        firstSeen: { type: 'datetime' },
        funding: { type: 'number' },
      },
    },
    insight: {
      fields: { statement: { type: 'text', required: true }, confidence: { type: 'number' } },
    },
  },
};

describe('validateMemorySchema — valid', () => {
  it('accepts and normalizes a well-formed schema', () => {
    const out = validateMemorySchema(ok);
    expect(Object.keys(out.objectTypes)).toEqual(['competitor', 'insight']);
    expect(out.objectTypes.competitor.fields.name).toEqual({ type: 'text', required: true });
    expect(out.objectTypes.competitor.fields.stage.values).toEqual(['seed', 'series-a', 'growth']);
    expect(out.objectTypes.competitor.strict).toBe(false);
  });

  it('accepts every field type', () => {
    const out = validateMemorySchema({
      objectTypes: { t: { fields: { a: { type: 'text' }, b: { type: 'number' }, c: { type: 'datetime' }, d: { type: 'boolean' }, e: { type: 'enum', values: ['x'] } } } },
    });
    expect(Object.keys(out.objectTypes.t.fields)).toHaveLength(5);
  });

  it('drops nothing but rejects unknown keys (normalized output is exactly the contract)', () => {
    const out = validateMemorySchema({ objectTypes: { t: { fields: { a: { type: 'text', required: false, description: 'hi' } } } } });
    expect(out.objectTypes.t.fields.a).toEqual({ type: 'text', required: false, description: 'hi' });
  });
});

describe('validateMemorySchema — rejects malformed', () => {
  const bad = (input: unknown) => expect(() => validateMemorySchema(input)).toThrow(MemorySchemaError);

  it('non-object schema', () => bad('nope'));
  it('missing objectTypes', () => bad({}));
  it('empty objectTypes', () => bad({ objectTypes: {} }));
  it('unknown top-level key (typo)', () => bad({ objectTypes: { t: { fields: { a: { type: 'text' } } } }, objectType: {} }));
  it('object type without fields', () => bad({ objectTypes: { t: { description: 'x' } } }));
  it('object type with empty fields', () => bad({ objectTypes: { t: { fields: {} } } }));
  it('unknown field-def key (typo: requird)', () => bad({ objectTypes: { t: { fields: { a: { type: 'text', requird: true } } } } }));
  it('invalid field type', () => bad({ objectTypes: { t: { fields: { a: { type: 'json' } } } } }));
  it('enum without values', () => bad({ objectTypes: { t: { fields: { a: { type: 'enum' } } } } }));
  it('enum with empty values', () => bad({ objectTypes: { t: { fields: { a: { type: 'enum', values: [] } } } } }));
  it('enum values not strings', () => bad({ objectTypes: { t: { fields: { a: { type: 'enum', values: [1, 2] } } } } }));
  it('values on a non-enum field', () => bad({ objectTypes: { t: { fields: { a: { type: 'text', values: ['x'] } } } } }));
  it('required not a boolean', () => bad({ objectTypes: { t: { fields: { a: { type: 'text', required: 'yes' } } } } }));
  it('strict not a boolean', () => bad({ objectTypes: { t: { strict: 'no', fields: { a: { type: 'text' } } } } }));
  it('invalid object type name', () => bad({ objectTypes: { 'bad name!': { fields: { a: { type: 'text' } } } } }));
  it('invalid field name', () => bad({ objectTypes: { t: { fields: { 'bad!': { type: 'text' } } } } }));
  it('enum over the value cap', () => bad({ objectTypes: { t: { fields: { a: { type: 'enum', values: Array.from({ length: SCHEMA_MAX_ENUM_VALUES + 1 }, (_, i) => `v${i}`) } } } } }));
});
