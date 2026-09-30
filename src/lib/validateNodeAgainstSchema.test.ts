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

  it('text: coercible (accepts string, finite number, boolean — parity with #719 asText)', () => {
    ok('competitor', { name: 'Letta' });
    ok('competitor', { name: 42 });
    ok('competitor', { name: true });
    bad('competitor', { name: {} }); // an object is not text-coercible
  });
});

describe('validateNodeAgainstSchema — strict collections', () => {
  it('rejects an undeclared key when strict', () => bad('strictThing', { id: 'x', extra: 'nope' }));
  it('accepts only-declared keys when strict', () => ok('strictThing', { id: 'x' }));
  it('open (default) collections allow extra keys', () => ok('competitor', { name: 'a', extra: 'fine' }));
  it('strict: rejects an inherited-prototype key name (own-property check)', () =>
    bad('strictThing', { id: 'x', toString: 'nope', constructor: 'evil' }));
});

describe('validateNodeAgainstSchema — platform-owned exports (#1286)', () => {
  const exports = { claudeSkill: { name: 'typed-task', description: 'Use when testing.', enable: true } };
  const collidingSchema: MemorySchema = {
    objectTypes: {
      task: {
        strict: true,
        fields: {
          title: { type: 'text', required: true },
          // A collection declaration cannot claim platform-owned exports,
          // even when it marks its own field required or gives it a type.
          exports: { type: 'text', required: true },
        },
      },
    },
  };

  it.each([false, true])('allows exports on an otherwise valid collection, strict=%s', (strict) => {
    const schema: MemorySchema = { objectTypes: { task: { strict, fields: { title: { type: 'text', required: true } } } } };
    expect(() => validateNodeAgainstSchema(schema, 'task', { title: 'T', exports })).not.toThrow();
    expect(() => validateNodeAgainstSchema(schema, 'task', { title: 'T', exports: null })).not.toThrow();
    expect(() => validateNodeAgainstSchema(schema, 'task', { title: 'T', exports: 'malformed' })).not.toThrow();
    const unrelated = () => validateNodeAgainstSchema(schema, 'task', { title: 'T', extra: 1, exports });
    if (strict) expect(unrelated).toThrow(NodeSchemaViolation);
    else expect(unrelated).not.toThrow();
  });

  it.each([false, true])('ignores a collection-owned exports field and its required flag, strict=%s', (strict) => {
    const schema = structuredClone(collidingSchema);
    schema.objectTypes.task.strict = strict;
    expect(() => validateNodeAgainstSchema(schema, 'task', { title: 'T' })).not.toThrow();
    expect(() => validateNodeAgainstSchema(schema, 'task', { title: 'T', exports })).not.toThrow();
    expect(() => validateNodeAgainstSchema(schema, 'task', { title: 'T', exports: 'malformed' })).not.toThrow();
    expect(() => validateNodeAgainstSchema(schema, 'task', { exports })).toThrow('required field "title" is missing');
  });

  it('still requires a declared collection and object-shaped properties', () => {
    expect(() => validateNodeAgainstSchema(collidingSchema, 'unknown', { exports })).toThrow(NodeSchemaViolation);
    expect(() => validateNodeAgainstSchema(collidingSchema, 'task', [] as unknown as Record<string, unknown>)).toThrow(
      'properties must be an object',
    );
  });
});

describe('validateNodeAgainstSchema — Codex hardening', () => {
  it('rejects "" as an undeclared collection (no empty-string bypass)', () => bad('', { name: 'x' }));
  it('rejects non-object properties for a collection member', () => {
    bad('competitor', 'text' as unknown as Record<string, unknown>);
    bad('competitor', [] as unknown as Record<string, unknown>);
  });
  it('an undeclared object type name that collides with Object.prototype is still rejected', () =>
    bad('hasOwnProperty', { x: 1 }));
});
