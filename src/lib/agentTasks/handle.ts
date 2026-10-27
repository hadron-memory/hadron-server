/**
 * #2553 (cor:agt:050:01, Proposed handle paragraph): the short handle of an agent task, `AT<n>(.<n>)*`. The first
 * segment is the PROJECT (a top-level task, counted per App; `AT0` is the reserved "no project" project); each
 * later segment is counted within its parent (`AT3.405.16`). An ALIAS for the task id: the id and the URN stay
 * canonical, and every surface that takes an id takes this. Immutable: parentage is fixed at creation.
 *
 * Two spellings, both parsed here and nowhere else:
 *   bare       AT3.405                                (the caller's own App decides which)
 *   qualified  hrn:agenttask:<app-urn>:AT3.405        (<app-urn> is the App's `<root>:<app-slug>`, App.urn)
 * The qualified grammar is proposed to the URN owner in the PR. Anything else is NOT a handle, and falls through to
 * the existing id path (which answers an unknown id).
 */

/** The largest number a segment can carry: the Postgres bigint ceiling. A longer or larger number is not a handle. */
const MAX_TASK_NUMBER = 9223372036854775807n;
/** Deepest handle: a project plus this many nested levels. Bounds the walk and the stored text (16 segments of at most 19 digits). */
export const MAX_HANDLE_DEPTH = 16;
const PROJECT = '(?:0|[1-9][0-9]{0,18})';
const SEGMENT = '[1-9][0-9]{0,18}';
const PATH = `AT${PROJECT}(?:\\.${SEGMENT})*`;
const BARE = new RegExp(`^(${PATH})$`, 'i');
const QUALIFIED = new RegExp(`^hrn:agenttask:([^\\s:/]+(?::[^\\s:/]+)+):(${PATH})$`, 'i');

export interface TaskHandle {
  /** The canonical spelling (`AT3.405`): upper case, which is how it is stored. */
  handle: string;
  /** The App's `<root>:<app-slug>` for a qualified handle, null for a bare one. */
  appUrn: string | null;
}

/** The handle `ref` spells, or null when it is not one. No trimming: a trailing space is not a handle. */
export function parseTaskHandle(ref: unknown): TaskHandle | null {
  if (typeof ref !== 'string') return null;
  const bare = BARE.exec(ref);
  const m = bare ?? QUALIFIED.exec(ref);
  if (!m) return null;
  const path = (bare ? m[1]! : m[2]!).toUpperCase();
  const segments = path.slice(2).split('.');
  if (segments.length > MAX_HANDLE_DEPTH) return null;
  if (segments.some((s) => BigInt(s) > MAX_TASK_NUMBER)) return null;
  return { handle: path, appUrn: bare ? null : m[1]! };
}

/** The handle of a child: its parent's handle (null for a project) plus its own segment. */
export const composeTaskHandle = (parentHandle: string | null, n: bigint | number): string =>
  parentHandle ? `${parentHandle}.${n}` : `AT${n}`;

/** Segments in a stored handle: 1 for a project. */
export const handleDepth = (handle: string): number => handle.split('.').length;

/** The qualified spelling: names the App by what its URN carries, so a line that crosses Apps stays unambiguous. */
export const qualifiedTaskHandle = (appUrn: string, handle: string): string => `hrn:agenttask:${appUrn}:${handle}`;
