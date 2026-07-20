/**
 * Unit tests for the object-store pure helpers (#745): flat projection, reserved
 * keys, loc/name derivation, and the match→where / sort→sortProperty desugaring
 * with schema-inferred casts. DB-free.
 */
import { describe, it, expect } from 'vitest';
import {
  projectNodeToObject,
  assertNoReservedKeys,
  deriveObjectLoc,
  deriveObjectName,
  castForField,
  matchToWhere,
  combineWhere,
  sortToPropertySort,
  ObjectStoreError,
} from './objectStore.js';
import type { MemorySchema } from './memorySchema.js';

const schema: MemorySchema = {
  objectTypes: {
    competitor: {
      fields: {
        name: { type: 'text' },
        stage: { type: 'enum', values: ['seed', 'series-a'] },
        fundingUsd: { type: 'number' },
        lastRoundAt: { type: 'datetime' },
        active: { type: 'boolean' },
      },
    },
  },
};

describe('projectNodeToObject', () => {
  it('flattens properties under { id, type }', () => {
    expect(projectNodeToObject({ id: 'n1', objectType: 'competitor', properties: { name: 'Letta', stage: 'seed' } })).toEqual({
      id: 'n1', type: 'competitor', name: 'Letta', stage: 'seed',
    });
  });
  it('id/type win over colliding property keys (envelope is authoritative)', () => {
    expect(projectNodeToObject({ id: 'n1', objectType: 'competitor', properties: { id: 'spoof', type: 'spoof', x: 1 } })).toEqual({
      id: 'n1', type: 'competitor', x: 1,
    });
  });
  it('handles null / non-object properties', () => {
    expect(projectNodeToObject({ id: 'n1', objectType: 'x', properties: null })).toEqual({ id: 'n1', type: 'x' });
    expect(projectNodeToObject({ id: 'n1', objectType: null, properties: [1, 2] })).toEqual({ id: 'n1', type: null });
  });
});

describe('assertNoReservedKeys', () => {
  it('rejects id / type as field names', () => {
    expect(() => assertNoReservedKeys({ id: 1 })).toThrow(ObjectStoreError);
    expect(() => assertNoReservedKeys({ type: 'x' })).toThrow(/reserved/);
    expect(() => assertNoReservedKeys({ name: 'ok' })).not.toThrow();
  });
});

describe('deriveObjectLoc', () => {
  it('uses the natural key when given', () => {
    expect(deriveObjectLoc('competitor', 'letta', () => 'GEN')).toBe('competitor:letta');
  });
  it('falls back to a generated id when no key', () => {
    expect(deriveObjectLoc('competitor', undefined, () => 'GEN')).toBe('competitor:GEN');
    expect(deriveObjectLoc('competitor', '  ', () => 'GEN')).toBe('competitor:GEN');
  });
});

describe('deriveObjectName', () => {
  it('prefers an explicit name, then name/title field, then the type', () => {
    expect(deriveObjectName('competitor', { name: 'Letta' }, 'Explicit')).toBe('Explicit');
    expect(deriveObjectName('competitor', { name: 'Letta' })).toBe('Letta');
    expect(deriveObjectName('competitor', { title: 'T' })).toBe('T');
    expect(deriveObjectName('competitor', { other: 1 })).toBe('competitor');
  });
});

describe('castForField', () => {
  it('uses the schema type (enum → text)', () => {
    expect(castForField(schema, 'competitor', 'fundingUsd')).toBe('number');
    expect(castForField(schema, 'competitor', 'lastRoundAt')).toBe('datetime');
    expect(castForField(schema, 'competitor', 'active')).toBe('boolean');
    expect(castForField(schema, 'competitor', 'stage')).toBe('text');
  });
  it('infers number/boolean from the value when there is no schema; else text', () => {
    expect(castForField(null, 'competitor', 'x', 42)).toBe('number');
    expect(castForField(null, 'competitor', 'x', true)).toBe('boolean');
    expect(castForField(null, 'competitor', 'x', '2026-01-01')).toBe('text'); // datetime needs a schema
  });
});

describe('matchToWhere', () => {
  it('single field → a single eq leaf with the schema-inferred cast', () => {
    expect(matchToWhere({ fundingUsd: 1000 }, 'competitor', schema)).toEqual({ path: ['fundingUsd'], as: 'number', eq: 1000 });
  });
  it('multiple fields → an AND of eq leaves', () => {
    expect(matchToWhere({ stage: 'series-a', active: true }, 'competitor', schema)).toEqual({
      and: [
        { path: ['stage'], as: 'text', eq: 'series-a' },
        { path: ['active'], as: 'boolean', eq: true },
      ],
    });
  });
  it('empty / null match → null', () => {
    expect(matchToWhere({}, 'competitor', schema)).toBeNull();
    expect(matchToWhere(null, 'competitor', schema)).toBeNull();
  });
});

describe('combineWhere', () => {
  const m = { path: ['a'], eq: 1 };
  const w = { path: ['b'], eq: 2 };
  it('ANDs match and where when both present', () => {
    expect(combineWhere(m, w)).toEqual({ and: [m, w] });
  });
  it('returns whichever is present, else undefined', () => {
    expect(combineWhere(m, null)).toEqual(m);
    expect(combineWhere(null, w)).toEqual(w);
    expect(combineWhere(null, null)).toBeUndefined();
  });
});

describe('sortToPropertySort', () => {
  it('desugars a single field with the schema cast', () => {
    expect(sortToPropertySort({ fundingUsd: 'desc' }, 'competitor', schema)).toEqual({ path: ['fundingUsd'], as: 'number', direction: 'desc' });
  });
  it('empty / null → undefined', () => {
    expect(sortToPropertySort({}, 'competitor', schema)).toBeUndefined();
    expect(sortToPropertySort(null, 'competitor', schema)).toBeUndefined();
  });
  it('rejects a bad direction', () => {
    expect(() => sortToPropertySort({ x: 'up' }, 'competitor', schema)).toThrow(/direction/);
  });
  it('rejects multiple sort fields (v1 is single-field)', () => {
    expect(() => sortToPropertySort({ a: 'asc', b: 'desc' }, 'competitor', schema)).toThrow(/single field/);
  });
});
