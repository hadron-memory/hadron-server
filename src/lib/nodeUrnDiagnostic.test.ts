/**
 * #4030 (follow-up to #3927) — `classifyMemoryShape` agrees with the emitter's own normalization (`bareAtoms` in
 * urnEmit.ts): the legacy `@` sigil is stripped and `::` collapses, so a memory identity the emitter ACCEPTS is
 * never classified INVALID, and one it refuses never ORDINARY/COMPOUND. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import { classifyLocShape, classifyMemoryShape } from './nodeUrnDiagnostic.js';
import { emitNodeUrnV2 } from './urnEmit.js';
import { MAX_ATOM_LEN } from './urn.js';

describe('classifyMemoryShape agrees with bareAtoms normalization', () => {
  const CASES: Array<[label: string, urn: string, shape: 'ORDINARY' | 'COMPOUND' | 'INVALID']> = [
    ['plain pair', 'org:mem', 'ORDINARY'],
    ['legacy @ sigil', '@org:mem', 'ORDINARY'],
    ['legacy @ sigil, compound', '@org:mem:agent:x', 'COMPOUND'],
    ['`::` hierarchy form', 'org::mem', 'ORDINARY'],
    ['`::` hierarchy form, compound', 'org::mem::sub', 'COMPOUND'],
    ['@ and ::', '@org::mem', 'ORDINARY'],
    ['repeated separators leave an empty atom', 'org::::mem', 'INVALID'],
    ['triple colon leaves an empty atom', 'org:::mem', 'INVALID'],
    ['only the first @ is a sigil', '@@org:mem', 'INVALID'],
    ['single atom', 'org', 'INVALID'],
    ['trailing separator', 'org:mem:', 'INVALID'],
  ];
  it.each(CASES)('%s (%s) is %s', (_l, urn, shape) => {
    expect(classifyMemoryShape(urn)).toBe(shape);
  });
  it.each(CASES)('%s: the classifier and the emitter accept and refuse the same identities', (_l, urn) => {
    let emits = true;
    try { emitNodeUrnV2(urn, 'a'); } catch { emits = false; }
    expect(classifyMemoryShape(urn) !== 'INVALID').toBe(emits);
  });
});

describe('classifyLocShape atom length bound', () => {
  it('an atom of exactly MAX_ATOM_LEN characters is ORDINARY; one more is ATOM_TOO_LONG', () => {
    expect(MAX_ATOM_LEN).toBe(64);
    expect(classifyLocShape('a'.repeat(MAX_ATOM_LEN))).toBe('ORDINARY');
    expect(classifyLocShape(`x:${'a'.repeat(MAX_ATOM_LEN)}`)).toBe('ORDINARY');
    expect(classifyLocShape('a'.repeat(MAX_ATOM_LEN + 1))).toBe('ATOM_TOO_LONG');
  });
});
