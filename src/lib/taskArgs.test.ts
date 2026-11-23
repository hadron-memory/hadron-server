/** #317 — the pure required-argument rule (spec cor:dmo:060:11 v1), no database. */
import { describe, it, expect } from 'vitest';
import { missingRequiredTaskArgs } from './taskArgs.js';

const DATA = {
  args: {
    a: { required: true },
    b: { required: true, default: 1 },
    c: { required: false },
    d: { data_type: 'string' },
    e: { required: 'true' },
    f: 'junk',
  },
};

describe('missingRequiredTaskArgs', () => {
  it('names only required, default-less arguments, in declaration order', () => {
    expect(missingRequiredTaskArgs({ args: { x: { required: true }, y: { required: true }, z: { required: false } } }, {})).toEqual(['x', 'y']);
    expect(missingRequiredTaskArgs(DATA, {})).toEqual(['a']);
  });

  it.each([null, undefined, 'a', 7, true, ['a']])('caller args %j is "no argument object": every required argument is missing, no throw', (bad) => {
    expect(missingRequiredTaskArgs(DATA, bad)).toEqual(['a']);
  });

  it('null counts as missing; empty string, 0 and false are present', () => {
    expect(missingRequiredTaskArgs(DATA, { a: null })).toEqual(['a']);
    expect(missingRequiredTaskArgs(DATA, { a: '' })).toEqual([]);
    expect(missingRequiredTaskArgs(DATA, { a: 0 })).toEqual([]);
    expect(missingRequiredTaskArgs(DATA, { a: false })).toEqual([]);
  });

  it('an inherited property is not a supplied argument', () => {
    expect(missingRequiredTaskArgs(DATA, Object.create({ a: 'x' }))).toEqual(['a']);
  });

  it.each([null, undefined, 'x', 3, [], { args: null }, { args: 'a' }, { args: ['a'] }])('node data %j declares nothing', (data) => {
    expect(missingRequiredTaskArgs(data, {})).toEqual([]);
  });
});
