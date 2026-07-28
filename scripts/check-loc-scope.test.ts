/**
 * Behavior of the unscoped-loc-lookup gate (#825).
 *
 * A gate nobody tests rots silently — which is the exact failure mode this one
 * exists to prevent, so its own rules are pinned here. Each case below is a
 * shape that came up while building it, several of them straight out of the
 * PR #826 review.
 */
// @ts-expect-error — plain .mjs checker, no type declarations by design
import { scanSource } from './check-loc-scope.mjs';

const scan = (src: string): number[] =>
  (scanSource(src) as Array<{ line: number }>).map((v) => v.line);

describe('check-loc-scope — flags an unscoped loc lookup', () => {
  it('a plain loc-keyed where', () => {
    expect(scan(`a = db.node.findFirst({ where: { loc: 'preflight' } });`)).toEqual([1]);
  });

  it('property SHORTHAND — `where: { loc }` is the same query', () => {
    // PR #826 review, Codex P2: requiring the token `loc:` let this through.
    expect(scan(`b = db.node.findFirst({ where: { loc } });`)).toEqual([1]);
  });

  it('memoryId present only in a SIBLING clause, not in the where', () => {
    // PR #826 review, Codex P2: scanning the whole line wrongly exempted this —
    // selecting memoryId does not constrain the lookup.
    expect(scan(`c = db.node.findFirst({ where: { loc: v }, select: { memoryId: true } });`)).toEqual([1]);
  });

  it('a where object spanning several lines', () => {
    const src = ['d = db.node.findFirst({', '  where: {', '    loc: v,', '    deletedAt: null,', '  },', '});'].join('\n');
    expect(scan(src)).toEqual([2]); // reported at the line `where:` starts on
  });
});

describe('check-loc-scope — leaves scoped and non-query shapes alone', () => {
  it('memoryId alongside loc in the same where', () => {
    expect(scan(`e = db.node.findFirst({ where: { loc: v, memoryId: m } });`)).toEqual([]);
  });

  it('the loc_memoryId composite unique', () => {
    expect(scan(`f = db.node.findUnique({ where: { loc_memoryId: { loc: v, memoryId: m } } });`)).toEqual([]);
  });

  it('`loc` as a VALUE rather than a key', () => {
    // `{ targetId: loc }` is keyed by targetId; an earlier cut read the value
    // as a shorthand key and false-positived on it.
    expect(scan(`g = db.pendingEdge.findMany({ where: { targetId: loc } });`)).toEqual([]);
  });

  it('a nested `loc` under a top-level memoryId', () => {
    expect(scan(`h = db.node.findFirst({ where: { memoryId: m, data: { loc: 1 } } });`)).toEqual([]);
  });

  it('memoryId arriving via a conditional spread', () => {
    expect(
      scan(`i = db.usageEvent.findMany({ where: { loc: v, ...(ids ? { memoryId: { in: ids } } : {}) } });`),
    ).toEqual([]);
  });

  it('prose in a comment that merely quotes the shape', () => {
    // Comments and string literals are blanked before scanning; a doc comment
    // describing `where: { loc, … }` is not a query (PR #826 review).
    expect(scan(`// see compileTemplate's \`where: { loc, memoryId }\`\nj = 1;`)).toEqual([]);
  });

  it('the same shape inside a string literal', () => {
    expect(scan(`const q = "where: { loc: 'x' }";`)).toEqual([]);
  });
});

describe('check-loc-scope — the escape hatch', () => {
  it('honors a marker on the line above', () => {
    expect(scan(`// loc-scope-ok: deliberate\nk = db.node.findFirst({ where: { loc: v } });`)).toEqual([]);
  });

  it('honors a marker on the same line', () => {
    expect(scan(`k = db.node.findFirst({ where: { loc: v } }); // loc-scope-ok: deliberate`)).toEqual([]);
  });

  it('honors a marker anywhere in the contiguous comment block above', () => {
    // A justification that wraps must still count — requiring exactly one line
    // silently voided real reasons (#825 hit this on its own helper).
    const src = [
      '  const rows = await db.node.findMany({',
      '    // loc-scope-ok: scoped by the shared read gate on the',
      '    // line below; ambiguity resolves to null.',
      '    where: { loc, deletedAt: null, ...access },',
      '  });',
    ].join('\n');
    expect(scan(src)).toEqual([]);
  });

  it('stops at the first non-comment line — a marker cannot reach past code', () => {
    expect(scan(`// loc-scope-ok: stale\nconst x = 1;\nk = db.node.findFirst({ where: { loc: v } });`)).toEqual([3]);
  });
});
