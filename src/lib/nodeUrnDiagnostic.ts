/**
 * #3927 — the sanitized diagnostic for a node URN that could not be emitted (`resolveNodeUrnField`'s catch).
 *
 * The old warning carried the raw memory URN and the library's exception, whose `input` and `offendingSegment`
 * are the stored loc: tenant-associated text in an operator log, and still no way to tell WHICH row failed or
 * HOW. This replaces it with one fixed event whose every field is an opaque id, a version, or a member of a
 * closed set. Nothing here changes what the field returns.
 *
 * Contract (issue #3927, CHECKED; governing cor:urn:010:01 and cor:dmo:060:02):
 * - `memoryId`: the opaque internal id already in hand; `nodeId`: only where the caller already loaded one, else null.
 *   No lookup, no hash, no key.
 * - `memoryShape` / `locShape` / `emissionError`: closed enums, classified from strings already in memory, by the
 *   library's own atom check (`validateAtomShape`, `MAX_ATOM_LEN`), not a second grammar.
 * - Never the raw loc, any atom or substring, a codepoint value, the memory URN, or the exception's text.
 */
import { MAX_ATOM_LEN, UrnParseError, validateAtomShape } from './urn.js';

export const NODE_URN_FALLBACK_EVENT = 'node.urn.emission_fallback';

export type MemoryShape = 'ORDINARY' | 'COMPOUND' | 'INVALID';
export type LocShape =
  | 'LEGACY_EMPTY_ROOT' | 'LEADING_EMPTY_ATOM' | 'TRAILING_EMPTY_ATOM' | 'INTERIOR_EMPTY_ATOM'
  | 'CONTROL_CODEPOINT' | 'WHITESPACE_CODEPOINT' | 'URL_STRUCTURAL_CODEPOINT' | 'NON_ASCII_CODEPOINT'
  | 'OTHER_FORBIDDEN_CODEPOINT' | 'ATOM_TOO_LONG' | 'ORDINARY' | 'OTHER';
export type EmissionError = 'WRONG_PART_COUNT' | 'INVALID_ATOM_SHAPE' | 'ATOM_TOO_LONG' | 'OTHER';

export interface NodeUrnFallbackEvent {
  schemaVersion: 1;
  memoryId: string;
  nodeId: string | null;
  memoryShape: MemoryShape;
  locShape: LocShape;
  emissionError: EmissionError;
}

const atomOk = (atom: string): boolean => {
  try { validateAtomShape(atom, atom); return true; } catch { return false; }
};

/**
 * The stored memory urn's shape. ORDINARY is the `<root>:<slug>` pair; COMPOUND is a longer chain of valid atoms
 * (a legacy memory minted before the single-slug flip); anything else, including an empty atom, is INVALID.
 * Mirrors `bareAtoms` in urnEmit (legacy `@` sigil stripped, `::` collapsed) so the two cannot disagree.
 */
export function classifyMemoryShape(memBareUrn: string): MemoryShape {
  const stripped = (memBareUrn.startsWith('@') ? memBareUrn.slice(1) : memBareUrn).replace(/::/g, ':');
  const atoms = stripped.split(':');
  if (atoms.length < 2 || !atoms.every(atomOk)) return 'INVALID';
  return atoms.length === 2 ? 'ORDINARY' : 'COMPOUND';
}

/**
 * The stored loc's shape, by a fixed precedence: the empty string (a memory's legacy root, a supported shape that
 * the grammar has no URN for, not a corrupt row); an empty atom (leading, trailing, then interior); the first
 * matching codepoint class over the whole loc (control, whitespace, URL-structural, non-ASCII, other forbidden);
 * an atom over the length bound; then ORDINARY when every atom passes the library's check, else OTHER.
 */
export function classifyLocShape(loc: string): LocShape {
  if (loc === '') return 'LEGACY_EMPTY_ROOT';
  const atoms = loc.split(':');
  if (atoms[0] === '') return 'LEADING_EMPTY_ATOM';
  if (atoms[atoms.length - 1] === '') return 'TRAILING_EMPTY_ATOM';
  if (atoms.includes('')) return 'INTERIOR_EMPTY_ATOM';
  const body = atoms.join('');
  if (/\p{Cc}/u.test(body)) return 'CONTROL_CODEPOINT';
  if (/[\s\p{Z}]/u.test(body)) return 'WHITESPACE_CODEPOINT';
  if (/[/?#%\\]/.test(body)) return 'URL_STRUCTURAL_CODEPOINT';
  if (/[^\x00-\x7f]/.test(body)) return 'NON_ASCII_CODEPOINT';
  if (/[^A-Za-z0-9._-]/.test(body)) return 'OTHER_FORBIDDEN_CODEPOINT';
  if (atoms.some((a) => a.length > MAX_ATOM_LEN)) return 'ATOM_TOO_LONG';
  return atoms.every(atomOk) ? 'ORDINARY' : 'OTHER';
}

/** The library's machine-stable reason, mapped to the closed set. Never the message. */
export function classifyEmissionError(err: unknown): EmissionError {
  if (!(err instanceof UrnParseError)) return 'OTHER';
  switch (err.reason) {
    case 'invalid-segment-shape': return 'WRONG_PART_COUNT'; // "wrong number of ':'-separated parts" (an empty atom or too few)
    case 'invalid-charset': return 'INVALID_ATOM_SHAPE';
    case 'slug-too-long': return 'ATOM_TOO_LONG';
    default: return 'OTHER';
  }
}

export function nodeUrnFallbackEvent(input: {
  memoryId: string;
  nodeId?: string | null;
  memUrn: string;
  loc: string;
  err: unknown;
}): NodeUrnFallbackEvent {
  return {
    schemaVersion: 1,
    memoryId: input.memoryId,
    nodeId: typeof input.nodeId === 'string' && input.nodeId !== '' ? input.nodeId : null,
    memoryShape: classifyMemoryShape(input.memUrn),
    locShape: classifyLocShape(input.loc),
    emissionError: classifyEmissionError(input.err),
  };
}
