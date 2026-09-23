/**
 * #1227 — the merge rule for `properties.exports` in isolation. The resolver
 * path (lock, persistence, concurrency) is covered in
 * resolvers.updateNodeProperties.test.ts; this file pins the algorithm.
 */
import { describe, it, expect } from 'vitest';
import { mergePatch, mergePropertiesPatch } from './exportsMerge.js';

const claude = { name: 'hadron-x', description: 'Use when X.', enable: true };
const codex = { name: 'hadron-x', description: 'Use when X, in Codex.', enable: true };

describe('mergePatch (RFC 7396)', () => {
  it('merges objects recursively', () => {
    expect(mergePatch({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('null deletes a key; deleting an absent key is a no-op', () => {
    expect(mergePatch({ a: 1, b: 2 }, { a: null, z: null })).toEqual({ b: 2 });
  });

  it('arrays and scalars replace, never merge', () => {
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(mergePatch({ a: { b: 1 } }, { a: 'x' })).toEqual({ a: 'x' });
  });

  it('an object patch onto a non-object target starts from {} and drops its nulls', () => {
    expect(mergePatch('scalar', { a: 1, b: null })).toEqual({ a: 1 });
    expect(mergePatch(undefined, { a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
  });

  it('does not mutate either argument', () => {
    const target = { a: { b: 1 } };
    const patch = { a: { c: 2 } };
    mergePatch(target, patch);
    expect(target).toEqual({ a: { b: 1 } });
    expect(patch).toEqual({ a: { c: 2 } });
  });
});

describe('a host literally named __proto__ is data, not a prototype (#1278 review)', () => {
  // JSON.parse makes "__proto__" an OWN key, and the declaration reader treats
  // it as a valid host (declaration.substrate.test.ts). Bracket assignment
  // would hit the inherited setter instead: the host would vanish from the
  // serialized result and the object's prototype would change.
  it('adds an own __proto__ host that survives serialization', () => {
    const patch = JSON.parse('{"__proto__": {"name": "x-y", "description": "d"}}');
    const merged = mergePatch({ claudeSkill: claude }, patch) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(merged))).toEqual(
      JSON.parse('{"claudeSkill": ' + JSON.stringify(claude) + ', "__proto__": {"name": "x-y", "description": "d"}}'),
    );
  });

  it('merges into, and deletes, an existing own __proto__ host', () => {
    const stored = JSON.parse('{"__proto__": {"name": "x-y", "description": "d", "enable": true}}');
    const flipped = mergePatch(stored, JSON.parse('{"__proto__": {"enable": false}}')) as Record<string, unknown>;
    expect(JSON.stringify(flipped)).toBe('{"__proto__":{"name":"x-y","description":"d","enable":false}}');
    const removed = mergePatch(stored, JSON.parse('{"__proto__": null}')) as Record<string, unknown>;
    expect(JSON.stringify(removed)).toBe('{}');
  });
});

describe('mergePropertiesPatch — exports gains depth, nothing else does', () => {
  it('writing one host keeps every sibling host (the #1227 defect)', () => {
    const merged = mergePropertiesPatch({ exports: { claudeSkill: claude } }, { exports: { codexSkill: codex } });
    expect(merged).toEqual({ exports: { claudeSkill: claude, codexSkill: codex } });
  });

  it('a partial host patch flips one field and keeps the rest of the host', () => {
    const merged = mergePropertiesPatch(
      { exports: { claudeSkill: claude, codexSkill: codex } },
      { exports: { codexSkill: { enable: false } } },
    );
    expect(merged).toEqual({ exports: { claudeSkill: claude, codexSkill: { ...codex, enable: false } } });
  });

  it('null removes one host and leaves the others', () => {
    const merged = mergePropertiesPatch(
      { exports: { claudeSkill: claude, codexSkill: codex } },
      { exports: { codexSkill: null } },
    );
    expect(merged).toEqual({ exports: { claudeSkill: claude } });
  });

  it('other nested keys keep the shallow rule: replaced whole', () => {
    const merged = mergePropertiesPatch({ other: { x: 1, y: 2 }, keep: 1 }, { other: { z: 3 } });
    expect(merged).toEqual({ other: { z: 3 }, keep: 1 });
  });

  it('a non-object exports in the patch replaces, as before #1227', () => {
    expect(mergePropertiesPatch({ exports: { claudeSkill: claude } }, { exports: null })).toEqual({ exports: null });
    expect(mergePropertiesPatch({ exports: { claudeSkill: claude } }, { exports: [] })).toEqual({ exports: [] });
  });

  it('merging onto no properties takes the patch, without storing delete-markers', () => {
    expect(mergePropertiesPatch(null, { a: 1, exports: { claudeSkill: claude, codexSkill: null } })).toEqual({
      a: 1,
      exports: { claudeSkill: claude },
    });
  });

  it('a malformed stored exports (not an object) is replaced by the patched object', () => {
    expect(mergePropertiesPatch({ exports: 'oops' }, { exports: { claudeSkill: claude } })).toEqual({
      exports: { claudeSkill: claude },
    });
  });
});
