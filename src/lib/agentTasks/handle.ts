/**
 * #2553 (cor:agt:050:01, Proposed handle paragraph): the short handle `AT<n>` of an agent task, `<n>` counted per
 * App. An ALIAS for the task id: the id and the URN stay canonical, and every surface that takes an id takes this.
 *
 * Two spellings, both parsed here and nowhere else:
 *   bare       AT312                                  (the caller's own App decides which)
 *   qualified  hrn:agenttask:<app-urn>:AT312          (<app-urn> is the App's `<root>:<app-slug>`, App.urn)
 * The qualified grammar is proposed to the URN owner in the PR. Anything else is NOT a handle, and falls through to
 * the existing id path (which answers an unknown id).
 */

/** The largest number a handle can carry: the Postgres bigint ceiling. A longer or larger number is not a handle. */
const MAX_TASK_NUMBER = 9223372036854775807n;
const NUMBER = '[1-9][0-9]{0,18}';
const BARE = new RegExp(`^AT(${NUMBER})$`, 'i');
const QUALIFIED = new RegExp(`^hrn:agenttask:([^\\s:/]+(?::[^\\s:/]+)+):AT(${NUMBER})$`, 'i');

export interface TaskHandle {
  number: bigint;
  /** The App's `<root>:<app-slug>` for a qualified handle, null for a bare one. */
  appUrn: string | null;
}

/** The handle `ref` spells, or null when it is not one. No trimming: a trailing space is not a handle. */
export function parseTaskHandle(ref: unknown): TaskHandle | null {
  if (typeof ref !== 'string') return null;
  const bare = BARE.exec(ref);
  const m = bare ?? QUALIFIED.exec(ref);
  if (!m) return null;
  const digits = bare ? m[1]! : m[2]!;
  const number = BigInt(digits);
  if (number > MAX_TASK_NUMBER) return null;
  return { number, appUrn: bare ? null : m[1]! };
}

export const formatTaskHandle = (n: bigint | number): string => `AT${n}`;

/** The qualified spelling: names the App by what its URN carries, so a line that crosses Apps stays unambiguous. */
export const qualifiedTaskHandle = (appUrn: string, n: bigint | number): string => `hrn:agenttask:${appUrn}:AT${n}`;
