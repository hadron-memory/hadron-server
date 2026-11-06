import { randomBytes } from 'node:crypto';

/**
 * #2135 — a per-render stand-in for the `{{>` that opens an include tag written
 * as code (cor:dmo:150:02: such a tag is literal text). Mustache is not
 * markdown-aware and would drop the tag as a partial with no definition, so the
 * splice swaps the opener for this guard before rendering and the renderer swaps
 * it back afterwards. It is never stored, cached or shared between renders.
 */
export function makeLiteralGuard(): string {
  return `\u0001hrn-lit-${randomBytes(16).toString('hex')}\u0001`;
}

/** Thrown when text meeting the render already contains the guard: the caller draws a fresh one and starts over. */
export class LiteralGuardCollision extends Error {
  constructor() {
    super('literal include guard collided with source text');
    this.name = 'LiteralGuardCollision';
  }
}

/** Put the literal `{{>` openers back. */
export function restoreLiteralTags(text: string, guard: string): string {
  return text.split(guard).join('{{>');
}
