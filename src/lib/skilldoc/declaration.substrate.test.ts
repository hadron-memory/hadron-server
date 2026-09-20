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
import { lintCollisions, lintNode, type SkillNode } from './lint.js';
import { render, SkillRenderError } from './render.js';
import { parseFile } from './parse.js';

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

describe('collision reporting is stable under corpus read order (@codex P2, #1233)', () => {
  it('emits the same findings, in the same order, for a permuted input', () => {
    // The corpus query returns nodes in whatever order it returns them. Sorting
    // only the NAMES left the findings — and each message's `others` list —
    // following that order, so two equivalent reads disagreed. A `--strict`
    // gate reading that is nondeterministic; a portal rendering it shows a diff
    // that is not a change.
    //
    // This is the one place this port deliberately diverges from Go, which has
    // the same defect. Not comparable against the fixtures by construction,
    // which is why it lives here.
    const mk = (urn: string): SkillNode => ({
      urn,
      loc: 'tasks:x',
      memoryUrn: 'hrn:mem:acme.com:mem',
      isRunnable: true,
      content: '# body',
      properties: { exports: { claudeSkill: { name: 'shared-name', description: 'd. Use when x.' } } },
    });
    const a = mk('hrn:node:a.com:m:one');
    const b = mk('hrn:node:b.com:m:two');
    const c = mk('hrn:node:c.com:m:three');

    const forward = lintCollisions([a, b, c]);
    const reversed = lintCollisions([c, b, a]);
    const shuffled = lintCollisions([b, c, a]);

    expect(forward).toEqual(reversed);
    expect(forward).toEqual(shuffled);
    // …and the report is non-empty, or three empty arrays would satisfy it.
    expect(forward).toHaveLength(3);
    expect(forward.map((f) => f.urn)).toEqual([
      'hrn:node:a.com:m:one',
      'hrn:node:b.com:m:two',
      'hrn:node:c.com:m:three',
    ]);
    // The message's `others` list is the half a name-only sort left moving.
    expect(forward[0].message).toContain('hrn:node:b.com:m:two, hrn:node:c.com:m:three');
  });
});

describe('the §4a id reaches the same one-line comment the source does', () => {
  it('refuses an id that would terminate the provenance comment', () => {
    // #1223 closed this for `source`; §4a adds a SECOND value to the same
    // line, so the guard has to arrive with it rather than be rediscovered.
    // Found by mutation: removing the guard reds nothing until this exists.
    const urn = 'hrn:node:acme.com:mem:tasks:x';
    for (const bad of ['a--> evil', 'a b', 'a\nb', 'a>b', '-->']) {
      expect(() => render('n', urn, 'd', 'body', bad), bad).toThrow(SkillRenderError);
    }
  });

  it('accepts the id shapes the platform actually mints, and writes them', () => {
    // The control: a guard that refused everything would satisfy the case
    // above. ULIDs and cuids are what `generateId` produces.
    const urn = 'hrn:node:acme.com:mem:tasks:x';
    for (const good of ['01a0bd36a0cd726aa3b68fb4ddf709c6', 'cme_abc-123', 'node-1']) {
      const out = render('n', urn, 'd', 'body', good);
      expect(out, good).toContain(` id=${good} `);
    }
  });

  it('omits the key entirely for the empty id, reproducing the pre-§4a header', () => {
    // What keeps the parity fixtures byte-comparable against Go, which writes
    // no id at all.
    const out = render('n', 'hrn:node:acme.com:mem:tasks:x', 'd', 'body', '');
    expect(out).not.toContain(' id=');
    expect(out).toMatch(/<!-- hadron-skill source=\S+ hash=[0-9a-f]{16} -->/);
  });

  it('the id does NOT change the hash', () => {
    // §4a is explicit: the hash must stay recomputable from the file alone,
    // and the id decides PAIRING rather than content. If it fed the hash,
    // every existing file would read as stale the moment ids started being
    // written.
    const urn = 'hrn:node:acme.com:mem:tasks:x';
    const withId = render('n', urn, 'd', 'body', 'node-1');
    const without = render('n', urn, 'd', 'body', '');
    const hashOf = (s: string): string => /hash=([0-9a-f]{16})/.exec(s)![1]!;
    expect(hashOf(withId)).toBe(hashOf(without));
  });

  it('round-trips: what render writes with an id, parseFile reads back', () => {
    const urn = 'hrn:node:acme.com:mem:tasks:x';
    const out = render('n', urn, 'd', 'body', 'node-1');
    const back = parseFile(out);
    expect(back.id).toBe('node-1');
    expect(back.source).toBe(urn);
    expect(back.body).toBe('body');
  });

  it('reads a header with no id as an empty id rather than refusing it', () => {
    // A pre-§4a file is still OURS — it classifies `unhashed`/`current`, not
    // foreign. Widening the existing class is §4a's instruction.
    const out = render('n', 'hrn:node:acme.com:mem:tasks:x', 'd', 'body', '');
    expect(parseFile(out).id).toBe('');
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
