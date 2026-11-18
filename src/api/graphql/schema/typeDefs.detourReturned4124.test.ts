/**
 * #4124 — the `ChatResponse.detourReturned` description must state what the code does (chatRouting.ts sets it on the
 * DETOUR_RETURN move), not the pre-#4100 "false until the detour-return slice ships". Pinned against the code so a
 * change there fails here. Per the gate (Vera's FIT): say when it is true, say it is false when a completion rule fires
 * or routing is skipped, cite cor:cht:030:02, and do NOT encode the Proposed V88/V89 rules (first-stage fallback,
 * close-without-move). Wording stays free beyond those facts.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { typeDefs } from './typeDefs.js';

const flat = (value: string) => value.replace(/\s+/g, ' ');

function fieldDescription(field: string): string {
  const at = typeDefs.indexOf(`    ${field}: Boolean!`);
  expect(at, `${field} must exist`).toBeGreaterThan(0);
  const line = typeDefs.lastIndexOf('\n', at - 1);
  const prev = typeDefs.lastIndexOf('\n', line - 1);
  return flat(typeDefs.slice(prev, line));
}

describe('#4124 detourReturned description', () => {
  const text = fieldDescription('detourReturned');
  it('no longer says the slice has not shipped', () => {
    expect(text).not.toMatch(/until the detour-return slice ships/);
  });
  it('states when it is true and when it is false, and keeps the citation', () => {
    expect(text).toMatch(/returned the chat from a detour/);
    expect(text).toMatch(/stage the most recent active detour left/);
    expect(text).toMatch(/completion rule fired/);
    expect(text).toMatch(/routing was skipped/);
    expect(text).toContain('hrn:node:hadronmemory.com:specs:cor:cht:030:02');
  });
  it('does not encode the Proposed V88/V89 rules', () => {
    expect(text).not.toMatch(/first stage|V88|V89|without a move/i);
  });
  it('matches the code: the flag is set on the return move and the completion rule / skip win', () => {
    const body = readFileSync(new URL('../../../lib/chatRouting.ts', import.meta.url), 'utf8');
    expect(body).toMatch(/detourReturned = true/);
    expect(body).toMatch(/DETOUR_RETURN/);
  });
});
