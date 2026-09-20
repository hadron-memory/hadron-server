/**
 * #1177 — the cases the parity fixtures CANNOT cover, because Go cannot
 * express them.
 *
 * `skilldoc.parity.test.ts` proves this port agrees with the Go reference over
 * inputs Go can build. That is the wrong gate for a whole class of defect:
 * a `map[string]any` has no prototype, cannot be an array, and cannot be null,
 * so the reference implementation is silent about every shape TypeScript adds.
 *
 * The rule this file exists for, learned on PR #1223: **a port must sometimes
 * do MORE than its reference in order to behave the SAME.** `extra['__proto__']`
 * vanishing on assignment was that lesson's first instance; these are the
 * declaration reader's.
 *
 * Nothing here is compared against Go. Each case states what the Go side would
 * do and asserts this side does the same, which is a claim about the CONTRACT
 * rather than about the fixture.
 */
import { describe, it, expect } from 'vitest';
import { classifyDeclaration, declaredSkill, malformedDeclarationPaths } from './declaration.js';
import { lintNode, type SkillNode } from './lint.js';

const node = (properties: unknown): SkillNode => ({
  urn: 'hrn:node:acme.com:mem:tasks:x',
  loc: 'tasks:x',
  memoryUrn: 'hrn:mem:acme.com:mem',
  isRunnable: true,
  content: '# body',
  properties,
});

describe('shapes `typeof x === "object"` admits and Go\'s map does not', () => {
  it('reports an ARRAY at `exports` as malformed, not as an empty host map', () => {
    // `typeof [] === 'object'` and `[] !== null`, so the naive object check
    // reads `"exports": []` as a valid host map with no hosts — silently "not
    // declared" instead of "your declaration is broken". Go's type assertion
    // to map[string]any rejects a slice, so the reference is right for free.
    expect(malformedDeclarationPaths({ exports: [] })).toEqual(['exports']);
    expect(declaredSkill({ exports: [] })).toBeNull();
  });

  it('reports an ARRAY host entry as malformed', () => {
    expect(malformedDeclarationPaths({ exports: { claudeSkill: [] } })).toEqual(['exports.claudeSkill']);
  });

  it('reports a NULL at `exports` as malformed', () => {
    // `typeof null === 'object'` — the other shape the naive check admits.
    expect(malformedDeclarationPaths({ exports: null })).toEqual(['exports']);
  });

  it('treats non-object `properties` as "no declaration" rather than throwing', () => {
    // A JSON column can hold a scalar or a list. Go would fail its assertion
    // and read no declaration; the TS equivalent must not index into a string.
    for (const props of [null, undefined, 'exports', 42, [], true]) {
      expect(() => classifyDeclaration(props)).not.toThrow();
      expect(declaredSkill(props)).toBeNull();
      expect(lintNode(node(props))).toEqual([]);
    }
  });
});

describe('the prototype chain, which a Go map does not have', () => {
  it('does not read an INHERITED `exports` as a declaration', () => {
    // `'exports' in obj` is true here while the node's own properties carry
    // nothing. Go has no equivalent, so the fixtures cannot catch a port that
    // used `in`.
    const inherited = Object.create({ exports: { claudeSkill: { name: 'x-y', description: 'd' } } }) as Record<string, unknown>;
    expect(declaredSkill(inherited)).toBeNull();
    expect(malformedDeclarationPaths(inherited)).toEqual([]);
  });

  it('does not read an inherited FIELD inside a host entry', () => {
    // The same hazard one level down: `description` inherited from a
    // prototype would be read as present-and-valid by `in`, and as
    // present-and-wrongly-typed by a naive `!== undefined`.
    const entry = Object.create({ description: 'inherited', name: 'inherited-name' }) as Record<string, unknown>;
    const decl = declaredSkill({ exports: { claudeSkill: entry } });
    expect(decl).not.toBeNull();
    expect(decl!.description).toBe('');
    expect(decl!.name).toBe('');
    expect(decl!.nameSet).toBe(false);
  });

  it('reads an OWN `__proto__` host key as an ordinary host', () => {
    // `JSON.parse` creates `__proto__` as an OWN property rather than invoking
    // the setter, so a node's properties really can carry one. It is a host
    // name like any other: shape-checked, not the claudeSkill declaration, and
    // it must neither throw nor pollute anything.
    const props = JSON.parse('{"exports": {"__proto__": {"name": "x-y", "description": "d"}}}') as unknown;
    expect(() => classifyDeclaration(props)).not.toThrow();
    expect(declaredSkill(props)).toBeNull();
    expect(malformedDeclarationPaths(props)).toEqual([]);
    expect(({} as Record<string, unknown>)['name']).toBeUndefined();
  });

  it('reports a malformed OWN `__proto__` host entry like any other host', () => {
    const props = JSON.parse('{"exports": {"__proto__": "nope"}}') as unknown;
    expect(malformedDeclarationPaths(props)).toEqual(['exports.__proto__']);
  });
});

describe('lines that are PROVABLY redundant rather than untested', () => {
  it('the frontmatter probe gives the same verdict with and without the appended newline', () => {
    // `lintNode` mirrors Go's `MatchString(body + "\n")`. Mutating that append
    // away reds nothing, which has two possible meanings — an untested line, or
    // a redundant one. This settles which: the pattern's tail is `[\s\S]*$`
    // and JS's `$` without `m` matches only at the very end, so the extra
    // newline is always consumed by the tail.
    const FRONTMATTER_RE = /^---\n(?:[\s\S]*?\n)?---\n?[\s\S]*$/;
    const bodies = [
      '---\ntitle: x\n---\nbody',
      '---\ntitle: x\n---',
      '---\n---',
      '---\n\nnot frontmatter',
      'plain body',
      '',
      '  ---\nindented\n  ---',
    ];
    for (const b of bodies) {
      expect(FRONTMATTER_RE.test(b), b).toBe(FRONTMATTER_RE.test(`${b}\n`));
    }
    // …and the probe can return BOTH answers over that set, or the assertion
    // above would hold for a predicate that is constant.
    expect(bodies.some((b) => FRONTMATTER_RE.test(b))).toBe(true);
    expect(bodies.some((b) => !FRONTMATTER_RE.test(b))).toBe(true);
  });
});

describe('determinism the reference gets from sorting', () => {
  it('orders malformed paths by host regardless of key insertion order', () => {
    // Object key order is insertion order, which is a property of how the row
    // was written rather than of the node. An unsorted list makes a `--strict`
    // gate nondeterministic across two reads of identical data — the defect
    // @Eli hit on the Go side with map iteration.
    const a = { exports: { zebra: 'no', alpha: 'no', mango: 'no' } };
    const b = { exports: { mango: 'no', zebra: 'no', alpha: 'no' } };
    const expected = ['exports.alpha', 'exports.mango', 'exports.zebra'];
    expect(malformedDeclarationPaths(a)).toEqual(expected);
    expect(malformedDeclarationPaths(b)).toEqual(expected);
  });
});
