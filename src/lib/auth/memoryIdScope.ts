/**
 * #3326: the one way a memory-set helper narrows its lookup to the memories a caller actually asks about.
 * A single id keeps the point-read behavior every existing caller has; a list narrows the SAME predicate to those ids
 * (`id IN (...)`), never widens it, so the result is the full answer restricted to them. An empty list matches nothing.
 */
export type OnlyMemoryIds = string | readonly string[];

/** The `id` filter for a narrowed lookup: the single id itself, or `{ in: ids }`. */
export function memoryIdFilter(only: OnlyMemoryIds): string | { in: string[] } {
  return typeof only === 'string' ? only : { in: [...only] };
}
