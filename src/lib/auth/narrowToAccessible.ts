/**
 * Spec 049 §2 S2 — intersect-and-disclose. THE one place a lens or a register
 * meets the caller's access.
 *
 * A scope resolves to `requested ∩ accessible` (D-2026-09-13-004: "a lens
 * never grants — a scope selects among memories the caller may already read
 * and can never add one"); a register entry's can-act is the host memory's
 * gate (D-2026-09-13-008). Both report the difference rather than failing —
 * D-004 rejected erroring because it "turns a legitimate App-wide scope into a
 * failure for every member lacking one memory".
 *
 * `accessible` is a fully MATERIALISED set, never an "unrestricted" sentinel
 * (hrn:node:hadronmemory.com:specs:cor:acl:120:01): the gates return an explicit
 * id list for platform admins precisely so the owner-only carve-out flows
 * through, and a helper that read a missing value as "keep everything" would
 * reintroduce those ids. #3921 removed the `'unrestricted'` arm once the GraphQL
 * gate could no longer return null; it had no caller left. The caller
 * materialises through the canonical gate (`getAccessibleMemoryIds` on GraphQL)
 * and passes the result here.
 *
 * Order-preserving: a scope is an ORDERED list and its order is what the
 * task-customization operation will consume. The dropped half comes back as
 * ids only; rendering a dropped id as a URN is the disclosure envelope's job
 * (S3), after the §8.2 visibility check — raw rows never cross this boundary.
 */
export interface NarrowedMemoryIds {
  /** The requested ids the caller may read, in the requested order. */
  kept: string[];
  /** The requested ids the caller may NOT read, in the requested order. */
  droppedIds: string[];
}

export function narrowToAccessible(
  requested: readonly string[],
  accessible: ReadonlySet<string>,
): NarrowedMemoryIds {
  const kept: string[] = [];
  const droppedIds: string[] = [];
  for (const id of requested) (accessible.has(id) ? kept : droppedIds).push(id);
  return { kept, droppedIds };
}
