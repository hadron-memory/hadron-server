/**
 * #4260 — apply the optional worker selector to one host's own rows. This is the pure tail of
 * `loadHostDesiredState` (the contract's full statement lives there and in the SDL); it is
 * extracted so its semantics are unit-testable without a database:
 *
 *  - no selector (undefined or empty): the host-wide list, unchanged;
 *  - an exact worker-ID match: that one row — ids are unique, so the ID FORM is the exactly-one
 *    path, and it wins over a name match (a worker whose name equals another's id selects the
 *    id's row alone);
 *  - otherwise every row whose exact name equals the selector, in the host's own order. In a
 *    provisioned database that is at most one row: worker names are unique per App,
 *    case-insensitively (`workers_app_name_uniq` — a functional unique on (app_id, lower(name))
 *    that Prisma's schema cannot express; prisma/post-push.sql and migration 20260814130000).
 *    The filter stays total anyway — a database that ever held same-named rows gets every one of
 *    them, never a silent first match;
 *  - a selector that matches nothing returns the same empty list as an unknown worker
 *    (cor:agt:020:08 concealment — see `loadHostDesiredState`).
 */
export function selectRows<T extends { workerId: string; name: string }>(rows: T[], selector: string | undefined): T[] {
  if (selector === undefined || selector === '') return rows;
  const byId = rows.filter((r) => r.workerId === selector);
  if (byId.length > 0) return byId;
  return rows.filter((r) => r.name === selector);
}
