import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #4376 / #4396: the comments of prisma/schema.prisma are documentation that nothing else checks.
// Two rules keep them from drifting back:
//   R1. every model has a `///` block directly above it (a declaration inserted between a block and its
//       model silently takes the block; see hadron-server findings:schema-doc-comment-drifts-onto-inserted-declaration);
//   R2. a spec citation in a `///` comment is the full node URN, never a bare `cor:` loc.

const lines = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8').split('\n');

/** Models whose declaration is not directly preceded by a `///` line. */
export function modelsWithoutComment(src: string[]): string[] {
  const out: string[] = [];
  src.forEach((line, i) => {
    const m = /^model (\w+) \{/.exec(line);
    if (m && !(src[i - 1] ?? '').startsWith('///')) out.push(m[1]);
  });
  return out;
}

const SPEC_PREFIX = 'hrn:node:hadronmemory.com:specs:';
const CITATION = /\bcor:[a-z]{3}:\d{3}(?::\d{2})?/g;
/** `///` lines carrying a `cor:<module>:<n>…` citation that is not written as the full node URN. */
export function bareCitations(src: string[]): string[] {
  const out: string[] = [];
  src.forEach((line, i) => {
    if (!/^\s*\/\/\//.test(line)) return;
    // Take the full URNs out; whatever citation is left is bare.
    const rest = line.split(SPEC_PREFIX).map((part, n) => (n === 0 ? part : part.replace(/^cor:[a-z]{3}(?::\d{3})?(?::\d{2})?/, ''))).join('');
    const bare = rest.match(CITATION);
    if (bare) out.push(`${i + 1}: ${bare[0]}`);
  });
  return out;
}

describe('#4376 schema.prisma comment guard', () => {
  it('R1: every model has a /// comment directly above it', () => {
    expect(modelsWithoutComment(lines)).toEqual([]);
  });

  it('R1 catches a model whose comment was taken by a declaration inserted above it', () => {
    const drifted = ['/// What a Thing is.', 'enum ThingKind {', '  A', '}', '', 'model Thing {', '  id String @id', '}'];
    expect(modelsWithoutComment(drifted)).toEqual(['Thing']);
    expect(modelsWithoutComment(['/// What a Thing is.', 'model Thing {'])).toEqual([]);
    expect(modelsWithoutComment(['/// What a Thing is.', '// a dated note', 'model Thing {'])).toEqual(['Thing']);
  });

  it('R2: no /// comment cites a spec by a bare cor: loc', () => {
    expect(bareCitations(lines)).toEqual([]);
  });

  it('R2 tells a bare citation from a full URN, also on one line', () => {
    expect(bareCitations(['/// See cor:agt:050:14.'])).toEqual(['1: cor:agt:050:14']);
    expect(bareCitations([`  /// See ${SPEC_PREFIX}cor:agt:050:14.`])).toEqual([]);
    expect(bareCitations([`/// ${SPEC_PREFIX}cor:agt:050:14 and cor:dmo:010`])).toEqual(['1: cor:dmo:010']);
    expect(bareCitations(['// plain note cor:agt:050:14', 'model X { // cor:agt:050:14'])).toEqual([]);
  });
});
