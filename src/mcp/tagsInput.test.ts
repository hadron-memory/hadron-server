/**
 * hadron-server#246 — lenient `tags` coercion for node-write MCP tools.
 *
 * The MCP SDK validates tool args through the registered zod input schema
 * before the handler runs (the createTestableMcpServer harness bypasses
 * zod, so this contract is pinned at the schema level here rather than
 * through a tool call). Covers the issue's acceptance criteria plus the
 * undefined→preserve and empty→clear edges that interact with the
 * partial-update contract (hadron-cli#37).
 */

import { describe, it, expect } from 'vitest';
import { tagsInputSchema } from './tagsInput.js';

describe('tagsInputSchema — comma-separated string coercion (#246)', () => {
  it('accepts a comma-separated string and splits it into an array', () => {
    expect(tagsInputSchema.parse('a, b, c')).toEqual(['a', 'b', 'c']);
    expect(tagsInputSchema.parse('portal,nodelist,pagination')).toEqual([
      'portal',
      'nodelist',
      'pagination',
    ]);
  });

  it('passes an existing string array through unchanged', () => {
    expect(tagsInputSchema.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(tagsInputSchema.parse([])).toEqual([]);
  });

  it('drops empty/whitespace-only entries when splitting', () => {
    expect(tagsInputSchema.parse('a,,b ')).toEqual(['a', 'b']);
    expect(tagsInputSchema.parse(' a , , b , ')).toEqual(['a', 'b']);
  });

  it('coerces a string that reduces to nothing into [] (explicit clear)', () => {
    expect(tagsInputSchema.parse('')).toEqual([]);
    expect(tagsInputSchema.parse('   ')).toEqual([]);
    expect(tagsInputSchema.parse(' , , ')).toEqual([]);
  });

  it('preserves undefined when optional (omitted → preserve, not cleared)', () => {
    // hadron_update_node gates on `tags !== undefined`; the optional wrapper
    // must short-circuit before preprocess so an omitted tags stays
    // undefined rather than failing array validation.
    expect(tagsInputSchema.optional().parse(undefined)).toBeUndefined();
  });

  it('still rejects genuinely malformed input (non-string, non-array)', () => {
    expect(tagsInputSchema.safeParse(42).success).toBe(false);
    expect(tagsInputSchema.safeParse({}).success).toBe(false);
    expect(tagsInputSchema.safeParse(null).success).toBe(false);
    expect(tagsInputSchema.safeParse(true).success).toBe(false);
  });

  it('still rejects an array containing a non-string element', () => {
    expect(tagsInputSchema.safeParse(['a', 1]).success).toBe(false);
  });
});
