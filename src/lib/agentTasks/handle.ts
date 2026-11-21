/**
 * #2553 (cor:agt:050:01, Proposed handle paragraph): the short handle of an agent task, `AT<n>(.<n>)*`. The first
 * segment is the PROJECT (a top-level task, counted per App; `AT0` is the reserved "no project" project); each
 * later segment is counted within its parent (`AT3.405.16`). An ALIAS for the task id: the id and the URN stay
 * canonical, and every surface that takes an id takes this. Immutable: parentage is fixed at creation.
 *
 * Two spellings, both parsed here and nowhere else:
 *   bare       AT3.405                                (the caller's own App decides which)
 *   qualified  hrn:agenttask:<app-urn>:at3.405        (<app-urn> is the App's `<root>:<app-slug>`, App.urn)
 * The qualified spelling is the task's URN (cor:urn:010:01): emitted with the handle in lower case (#3878, ruling
 * 0278), read in either case. Anything else is NOT a handle, and falls through to the existing id path (which answers
 * an unknown id).
 */

import { composeAgentTaskUrnV2, UrnParseError } from '../urn.js';

/** The largest number a segment can carry: the Postgres bigint ceiling. A longer or larger number is not a handle. */
const MAX_TASK_NUMBER = 9223372036854775807n;
/** Deepest handle: a project plus this many nested levels. Bounds the walk and the stored text (16 segments of at most 19 digits). */
export const MAX_HANDLE_DEPTH = 16;
/** cor:urn:010:01: a handle is a URN leaf, so it is at most 64 characters like any atom. Longer is not a handle. */
export const MAX_HANDLE_LENGTH = 64;
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
  if (path.length > MAX_HANDLE_LENGTH) return null;
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

/**
 * #3878 (hrn:node:hadronmemory.com:specs:cor:urn:010:01, the Agent task row; ruling 0278): the task's URN,
 * `hrn:agenttask:<root>:<app-slug>:<handle>`, COMPUTED from the App's stored bare `<root>:<slug>` urn and the stored
 * handle (no column), and EMITTED WITH THE HANDLE IN LOWER CASE (`…:at3.405`). Input stays case-insensitive
 * ({@link parseTaskHandle} upper-cases), and the displayed handle stays `AT3.405`. The App part is emitted as stored:
 * App references are matched as written (resolveAppRef), so folding it would emit an address that may not resolve.
 *
 * The one emission of this URN: `AgentTask.urn`, the MCP task read and every hint that shows the qualified form use it,
 * so no two spellings disagree. Throws `UrnParseError` when the App urn is not the `<root>:<slug>` pair the fixed
 * arity needs (composeAgentTaskUrnV2 checks the atoms and the arity), so a caller that conceals turns that into null.
 */
export function agentTaskUrn(appUrn: string, handle: string): string {
  const firstColon = appUrn.indexOf(':');
  if (firstColon === -1) throw new UrnParseError(appUrn, 'invalid-segment-shape');
  return composeAgentTaskUrnV2(appUrn.slice(0, firstColon), appUrn.slice(firstColon + 1), handle.toLowerCase());
}

/** The qualified spelling: names the App by what its URN carries, so a line that crosses Apps stays unambiguous. #3878: it is the task's URN. */
export const qualifiedTaskHandle = agentTaskUrn;
