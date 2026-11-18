import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #4376 / #4396: the comments of prisma/schema.prisma are documentation that nothing else checks.
// Two rules keep them from drifting back:
//   R1. every model and every enum has a `///` block directly above it (a declaration inserted between a block
//       and its declaration silently takes the block; see hadron-server
//       findings:schema-doc-comment-drifts-onto-inserted-declaration);
//   R2. a spec citation in a `///` comment is the full node URN, never a bare `cor:` loc.

const SCHEMA = new URL('../../prisma/schema.prisma', import.meta.url);
/** Read inside each test, so a moved or missing schema file fails with its path, not as a module-load error. */
function schemaLines(): string[] {
  try {
    return readFileSync(SCHEMA, 'utf8').split('\n');
  } catch (e) {
    throw new Error(`cannot read ${SCHEMA.pathname}: ${(e as Error).message}`);
  }
}

/** Models and enums whose declaration is not directly preceded by a `///` line, as `<line>: <kind> <Name>`. */
export function declarationsWithoutComment(src: string[]): string[] {
  const out: string[] = [];
  src.forEach((line, i) => {
    const m = /^(model|enum) (\w+) \{/.exec(line);
    if (m && !(src[i - 1] ?? '').startsWith('///')) out.push(`${i + 1}: ${m[1]} ${m[2]}`);
  });
  return out;
}

const SPEC_PREFIX = 'hrn:node:hadronmemory.com:specs:';
/** One pattern for a spec loc, used both to find citations and to take the full URNs out. */
const LOC = 'cor:[a-z]+(?::\\d+)+';
const FULL_URN = new RegExp(SPEC_PREFIX.replace(/[.]/g, '\\.') + LOC, 'g');
const CITATION = new RegExp('\\b' + LOC, 'g');
/** `///` lines carrying a spec loc that is not written as the full node URN, as `<line>: <every bare loc>`. */
export function bareCitations(src: string[]): string[] {
  const out: string[] = [];
  src.forEach((line, i) => {
    if (!/^\s*\/\/\//.test(line)) return;
    const bare = line.replace(FULL_URN, '').match(CITATION);
    if (bare) out.push(`${i + 1}: ${bare.join(', ')}`);
  });
  return out;
}

describe('#4376 schema.prisma comment guard', () => {
  it('R1: every model and enum has a /// comment directly above it', () => {
    expect(declarationsWithoutComment(schemaLines())).toEqual([]);
  });

  it('R1 catches a declaration whose comment was taken by one inserted above it', () => {
    const drifted = ['/// What a Thing is.', 'enum ThingKind {', '  A', '}', '', 'model Thing {', '  id String @id', '}'];
    expect(declarationsWithoutComment(drifted)).toEqual(['6: model Thing']);
    // The same drift the other way round: a model inserted between a block and its enum.
    const enumLost = ['/// The kinds of Thing.', 'model Thing {', '  id String @id', '}', '', 'enum ThingKind {', '  A', '}'];
    expect(declarationsWithoutComment(enumLost)).toEqual(['6: enum ThingKind']);
    expect(declarationsWithoutComment(['/// What a Thing is.', 'model Thing {'])).toEqual([]);
    expect(declarationsWithoutComment(['/// What a Thing is.', '// a dated note', 'model Thing {'])).toEqual(['3: model Thing']);
  });

  it('R2: no /// comment cites a spec by a bare cor: loc', () => {
    expect(bareCitations(schemaLines())).toEqual([]);
  });

  it('R2 tells a bare citation from a full URN, reports every one on a line, and takes any loc depth', () => {
    expect(bareCitations(['/// See cor:agt:050:14.'])).toEqual(['1: cor:agt:050:14']);
    expect(bareCitations([`  /// See ${SPEC_PREFIX}cor:agt:050:14.`])).toEqual([]);
    expect(bareCitations([`/// ${SPEC_PREFIX}cor:agt:050:14 and cor:dmo:010, cor:acl:140:07`])).toEqual(['1: cor:dmo:010, cor:acl:140:07']);
    expect(bareCitations(['/// cor:newmodule:1:2:3'])).toEqual(['1: cor:newmodule:1:2:3']);
    expect(bareCitations(['// plain note cor:agt:050:14', 'model X { // cor:agt:050:14'])).toEqual([]);
  });
});
