/**
 * The one definition of how a `<field>Page` sibling sizes its page (cor:api:120:04, #2213 S1, #2212 A2): an
 * omitted or null limit pages at 20; 0 is count-only; a negative limit is 0; a limit over 200 is served as 200,
 * never a refusal. Shared by the resolvers (`pageArgs`) and by complexity admission (`admissionComplexity.ts`),
 * so the work admission charges for is the work the resolver does and the two cannot drift apart.
 */
export const PAGE_ARGS_DEFAULT = 20;
export const PAGE_ARGS_MAX = 200;

/** How many rows a stated `limit` actually reads. */
export function pageTake(limit: number | null | undefined): number {
  return Math.min(PAGE_ARGS_MAX, Math.max(0, limit ?? PAGE_ARGS_DEFAULT));
}
