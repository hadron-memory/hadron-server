/**
 * Unit tests for node-vs-schema enforcement (#725 PR C1). Pure — no DB.
 */
import { describe, it, expect } from 'vitest';
import { validateNodeAgainstSchema, NodeSchemaViolation } from './validateNodeAgainstSchema.js';
import type { MemorySchema } from './memorySchema.js';

const schema: MemorySchema = {
  objectTypes: {
    competitor: {
      fields: {
        name: { type: 'text', required: true },
        stage: { type: 'enum', values: ['seed', 'series-a'] },
        firstSeen: { type: 'datetime' },
        funding: { type: 'number' },
        active: { type: 'boolean' },
      },
    },
    strictThing: {
      strict: true,
      fields: { id: { type: 'text', required: true } },
    },
  },
};

const ok = (objectType: string | null, props: Record<string, unknown> | null) =>
  expect(() => validateNodeAgainstSchema(schema, objectType, props)).not.toThrow();
const bad = (objectType: string | null, props: Record<string, unknown> | null) =>
  expect(() => validateNodeAgainstSchema(schema, objectType, props)).toThrow(NodeSchemaViolation);

describe('validateNodeAgainstSchema — no-ops', () => {
  it('no schema → free-form (any objectType/props pass)', () => {
    expect(() => validateNodeAgainstSchema(null, 'anything', { x: 1 })).not.toThrow();
    expect(() => validateNodeAgainstSchema(undefined, 'anything', null)).not.toThrow();
  });
  it('no objectType → not a collection member, no property check', () => {
    ok(null, { arbitrary: 'value' });
  });
});

describe('validateNodeAgainstSchema — objectType must be declared', () => {
  it('rejects an undeclared collection', () => bad('gadget', { name: 'x' }));
  it('accepts a declared collection with valid props', () => ok('competitor', { name: 'Letta' }));
});

describe('validateNodeAgainstSchema — required + types', () => {
  it('rejects a missing required field', () => bad('competitor', { stage: 'seed' }));
  it('rejects an explicit null required field', () => bad('competitor', { name: null }));
  it('accepts optional fields omitted', () => ok('competitor', { name: 'Letta' }));

  it('number: accepts a number OR a numeric string, rejects junk', () => {
    ok('competitor', { name: 'a', funding: 1000000 });
    ok('competitor', { name: 'a', funding: '1000000' });
    bad('competitor', { name: 'a', funding: 'lots' });
  });
  it('datetime: accepts a parseable ISO string, rejects junk', () => {
    ok('competitor', { name: 'a', firstSeen: '2026-07-10T00:00:00Z' });
    bad('competitor', { name: 'a', firstSeen: 'not-a-date' });
  });
  it('boolean: accepts bool or "true"/"false", rejects other', () => {
    ok('competitor', { name: 'a', active: true });
    ok('competitor', { name: 'a', active: 'false' });
    bad('competitor', { name: 'a', active: 'maybe' });
  });
  it('enum: accepts a declared value, rejects an undeclared one', () => {
    ok('competitor', { name: 'a', stage: 'series-a' });
    bad('competitor', { name: 'a', stage: 'series-z' });
  });
});

describe('validateNodeAgainstSchema — strict collections', () => {
  it('rejects an undeclared key when strict', () => bad('strictThing', { id: 'x', extra: 'nope' }));
  it('accepts only-declared keys when strict', () => ok('strictThing', { id: 'x' }));
  it('open (default) collections allow extra keys', () => ok('competitor', { name: 'a', extra: 'fine' }));
});
