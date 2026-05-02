/**
 * Shape detector for the entity-reference convention (spec 007).
 *
 * Recognizes the two ID formats the platform uses today:
 *
 *   - **cuid** (Prisma `@default(cuid())`) — 25 chars, starts with `c`,
 *     remaining 24 are lowercase alphanumeric. Used by Organization,
 *     Memory, Agent, App, Node, Edge, OrgMember, Session, etc.
 *   - **UUIDv7 hex** (`generateId()` from `src/lib/id.ts`) — 32 lowercase
 *     hex characters. Used where the spec calls for time-sortable IDs
 *     (assets, sessions in some places, anywhere `generateId()` is
 *     called explicitly).
 *
 * Anything else is treated as a URN — including bare URNs
 * (`org-foo:family-mealplan`), domain-shaped org URNs
 * (`hadronmemory.com`), and short slug-shaped org URNs (`org-a`).
 * After upstream prefix-normalization (see `parseUrnInput` in
 * `src/lib/urn.ts`) any `urn:<type>:` prefix is stripped before this
 * function sees the input.
 *
 * Why this heuristic instead of "contains `:`"?
 *
 * Memory / Agent / App URNs always contain `:` (they're constructed
 * as `<org-urn>:<value>`), so the colon-presence check works for
 * them. **Organization URNs are different** — they're often simple
 * slugs without a colon (`hadronmemory.com`, `org-a`), so the colon
 * check would mis-dispatch a URN-shaped input to ID lookup. Matching
 * known ID formats explicitly dispatches correctly across all four
 * in-scope entity types.
 *
 * Edge case: a hypothetical URN that happens to match the cuid or
 * UUIDv7-hex regex would mis-dispatch as an ID. URNs are human-
 * meaningful identifiers (slugs, domains, hierarchical paths); this
 * collision is theoretical, not practical. If a future entity adds
 * an ID format outside these two regexes, this file is amended along
 * with the spec.
 */

const UUIDV7_HEX = /^[0-9a-f]{32}$/;
const CUID = /^c[a-z0-9]{24}$/;

export function isId(s: string): boolean {
  return UUIDV7_HEX.test(s) || CUID.test(s);
}
