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
import { classifyDeclaration, declaredSkill, malformedDeclarationPaths, unknownHostKeys } from './declaration.js';
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

  it('sees an OWN `__proto__` host key like any other key', () => {
    // Since #1292 an unknown key is not shape-checked, so this is no longer a
    // malformed path; the own-key detection it pins moved to unknownHostKeys,
    // which must still see the key rather than lose it to the prototype.
    const props = JSON.parse('{"exports": {"__proto__": "nope"}}') as unknown;
    expect(malformedDeclarationPaths(props)).toEqual([]);
    expect(unknownHostKeys(props)).toEqual(['__proto__']);
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
      properties: { exports: { claudeSkill: { name: 'shared-name', description: 'd. Use when x.', enable: true } } },
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

describe('the provenance header: read and write must accept the same thing', () => {
  it('REFUSES to read back a header the write path would not have written — id', () => {
    // @copilot, PR #1234. `render` never writes an id that could close the
    // comment, so `parseFile` must not accept one: a hand-edited
    // `id=a-->` ends the comment early, the host shows the remainder as body,
    // and the parser would still call the line ours.
    //
    // Built by hand rather than by `render` on purpose, and it stays that way
    // now that #1235 shipped the write side: `render` REFUSES an id carrying
    // `-->` (that is the guard under test), so it cannot produce the tampered
    // specimen this case needs. A fixture the writer would reject is exactly
    // what a parser hardening test has to construct itself.
    const urn = 'hrn:node:acme.com:mem:tasks:x';
    const h = 'a'.repeat(16);
    const ours = `---\nname: n\ndescription: d\n---\n\n<!-- hadron-skill source=${urn} id=node-1 hash=${h} -->\n\nbody\n`;
    const tampered = ours.replace('id=node-1', 'id=a-->');

    expect(parseFile(ours).id).toBe('node-1');
    expect(parseFile(ours).source).toBe(urn);
    // …and the tampered line stops being ours, which is what makes the file
    // read as foreign rather than as a clean export of that node.
    expect(parseFile(tampered).id).toBe('');
    expect(parseFile(tampered).source).toBe('');
  });

  it('REFUSES to read back a header the write path would not have written — source', () => {
    // The same asymmetry one field over, and the one my first fix missed:
    // `isNodeUrn` checks STRUCTURE, not the charset `render` enforces, so
    // `source=hrn:node:a.com:m:evil-->` parsed as ours. Fixing the instance
    // and not the class is how a ban-list stays one report behind.
    const h = 'a'.repeat(16);
    const bad = `---\nname: n\ndescription: d\n---\n\n<!-- hadron-skill source=hrn:node:a.com:m:evil--> hash=${h} -->\n\nbody\n`;
    expect(parseFile(bad).source).toBe('');
  });

  it('the LEGACY header path gets the same charset, not just the machine one', () => {
    // Two header generations, one rule. Guarding only the machine line would
    // leave the older shape as the way in — the writer nobody enumerated,
    // which is #1224's sentence.
    const legacy = `---\nname: n\ndescription: d\n---\n\n<!-- Generated from hrn:node:a.com:m:evil--> -->\n\nbody\n`;
    expect(parseFile(legacy).source).toBe('');
    const clean = `---\nname: n\ndescription: d\n---\n\n<!-- Generated from hrn:node:a.com:m:ok -->\n\nbody\n`;
    expect(parseFile(clean).source).toBe('hrn:node:a.com:m:ok');
  });

  it('a header with NO id is still ours — a pre-§4a file is not foreign', () => {
    // Absent and invalid are different: absent means an older header
    // generation that pairs by source and is preserved without force; invalid
    // means edited.
    const out = render('', 'n', 'hrn:node:acme.com:mem:tasks:x', 'd', 'body');
    expect(parseFile(out).id).toBe('');
    expect(parseFile(out).source).toBe('hrn:node:acme.com:mem:tasks:x');
  });

  it('CONTROL: render still refuses an unsafe SOURCE, so both paths agree', () => {
    expect(() => render('', 'n', 'hrn:node:a.com:m:evil-->', 'd', 'body')).toThrow(SkillRenderError);
  });
});

describe('determinism the reference gets from sorting', () => {
  it('orders malformed paths by host regardless of key insertion order', () => {
    // Object key order is insertion order, which is a property of how the row
    // was written rather than of the node. An unsorted list makes a `--strict`
    // gate nondeterministic across two reads of identical data — the defect
    // @Eli hit on the Go side with map iteration.
    //
    // Since #1292 only KNOWN hosts are shape-checked, so the malformed half
    // runs over the two known hosts, and the ordering of unknown keys is
    // pinned on unknownHostKeys, which reports them now.
    expect(malformedDeclarationPaths({ exports: { codexSkill: 'no', claudeSkill: 'no' } })).toEqual([
      'exports.claudeSkill',
      'exports.codexSkill',
    ]);
    expect(malformedDeclarationPaths({ exports: { claudeSkill: 'no', codexSkill: 'no' } })).toEqual([
      'exports.claudeSkill',
      'exports.codexSkill',
    ]);
    const a = { exports: { zebra: 'no', alpha: 'no', mango: 'no' } };
    const b = { exports: { mango: 'no', zebra: 'no', alpha: 'no' } };
    expect(unknownHostKeys(a)).toEqual(['alpha', 'mango', 'zebra']);
    expect(unknownHostKeys(b)).toEqual(['alpha', 'mango', 'zebra']);
  });
});
