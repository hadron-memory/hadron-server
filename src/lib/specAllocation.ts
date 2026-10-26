// #1178 — the numbering grammar of the server-side citation allocator
// (`allocateSpecNode`). Ported from the CLI's `spec new` (allocate.go) so the
// server hands out the same numbers the client used to compute:
//   - features are numbered in tens (010, 020, …, 990), width 3;
//   - rules and flows step by one (01..99), width 2;
//   - rule `00` (a feature's general provisions) is never allocated;
//   - an `after` floor lands the number strictly above it.
// R216 (Holger, 2026-10-24): a number that was ever minted is never handed out
// again, so the floor sits above the highest ever-minted sibling, counting
// deleted, archived and moved-out nodes. Pure functions only; the resolver owns
// every read.

export type SpecChildKind = 'feature' | 'rule' | 'flow';

export interface SpecLevel {
  kind: SpecChildKind;
  step: number;
  max: number;
  width: number;
}

const MODULE_CODE = /^[a-z]{3}$/;
const THREE_DIGITS = /^\d{3}$/;
const TWO_DIGITS = /^\d{2}$/;

const LEVELS: Record<SpecChildKind, SpecLevel> = {
  feature: { kind: 'feature', step: 10, max: 990, width: 3 },
  rule: { kind: 'rule', step: 1, max: 99, width: 2 },
  flow: { kind: 'flow', step: 1, max: 99, width: 2 },
};

/**
 * What a child of `parentLoc` would be, or null when the parent is not a
 * citation that can take numbered children: a bare product root (its children
 * are module codes, which are chosen, not allocated), a flow (the deepest
 * level), or a loc outside the citation grammar.
 *
 * Grammar: `[<product>:]<module>[:<feature>[:<rule>[:<flow>]]]`. A single alpha
 * segment is a flat-corpus module; the resolver separately refuses it when it
 * already has alphabetic children (then it is a product root).
 */
export function childKindOf(parentLoc: string): SpecChildKind | null {
  const parts = parentLoc.split(':');
  if (!MODULE_CODE.test(parts[0] ?? '')) return null;
  let rest = parts;
  if (parts.length > 1 && MODULE_CODE.test(parts[1])) rest = parts.slice(1);
  if (rest.length > 4) return null;
  if (rest.length > 1 && !THREE_DIGITS.test(rest[1])) return null;
  if (rest.length > 2 && !TWO_DIGITS.test(rest[2])) return null;
  if (rest.length > 3 && !TWO_DIGITS.test(rest[3])) return null;
  switch (rest.length) {
    case 1: return 'feature';
    case 2: return 'rule';
    case 3: return 'flow';
    default: return null;
  }
}

export function specLevel(kind: SpecChildKind): SpecLevel {
  return LEVELS[kind];
}

/**
 * The number segment of `loc` when it is a direct numbered child of
 * `parentLoc` at the given level, else null. An archived tombstone
 * (`<child>__deleted-<id>`) counts as its child's number.
 */
export function childNumberAt(parentLoc: string, loc: string, level: SpecLevel): number | null {
  const prefix = `${parentLoc}:`;
  if (!loc.startsWith(prefix)) return null;
  const seg = loc.slice(prefix.length).replace(/__deleted-.*$/, '');
  const shape = level.width === 3 ? THREE_DIGITS : TWO_DIGITS;
  if (!shape.test(seg)) return null;
  return Number(seg);
}

/**
 * The lowest free number strictly above `max(everMinted, after)` on the level's
 * grid, skipping every number in `taken` (a row of ANY state holds its loc, so a
 * tombstone or a live draft is never reused here), or null when the space is
 * exhausted. Rule `00` is never produced: the lowest rule is 01.
 */
export function nextSpecNumber(
  level: SpecLevel,
  everMinted: number,
  taken: ReadonlySet<number>,
  after: number | null,
): number | null {
  const floor = Math.max(everMinted, after ?? 0);
  let n = (Math.floor(floor / level.step) + 1) * level.step;
  if (n < level.step) n = level.step;
  for (; n <= level.max; n += level.step) {
    if (!taken.has(n)) return n;
  }
  return null;
}

export function formatSpecNumber(level: SpecLevel, n: number): string {
  return String(n).padStart(level.width, '0');
}
