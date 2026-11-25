/**
 * #5183 (cor:dmo:060:20): the derived slug of a user's personal or private memory in an App,
 * `<app slug>-<owner handle>-<class>`, with the numeric tail of R2 (`-2`, `-3`, ...) when the name is taken.
 * Pure: the caller probes which candidate is free.
 */
import { deriveSlugFromName, MAX_ATOM_LEN } from './urn.js';

/** How many candidates the caller probes before it gives up (the tail is 1..MAX_TAIL). */
export const APP_USER_MEMORY_MAX_TAIL = 100;

function part(text: string): string {
  try { return deriveSlugFromName(text); } catch { return 'x'; }
}

/**
 * Candidate `n` (1-based). Candidate 1 has no tail. A name over the 64-character atom cap is cut in its
 * App-and-handle part only, so `-<class>` and any tail always survive, and the cut never leaves a trailing separator.
 */
export function appUserMemorySlug(
  args: { appSlug: string; handle: string; memoryClass: 'personal' | 'private' },
  n: number,
): string {
  const ending = `-${args.memoryClass}${n >= 2 ? `-${n}` : ''}`;
  const stem = `${part(args.appSlug)}-${part(args.handle)}`;
  const room = MAX_ATOM_LEN - ending.length;
  const cut = stem.length > room ? stem.slice(0, room).replace(/[._-]+$/g, '') || 'x' : stem;
  return `${cut}${ending}`;
}
