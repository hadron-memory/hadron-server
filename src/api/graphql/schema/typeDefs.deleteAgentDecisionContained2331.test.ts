/**
 * #2331 — deleteAgent's description must name the DECISION_CONTAINED refusal.
 * The resolver runs assertNoMintedCorpusRemoval, whose decision check
 * (memoryHoldsDecisions) sits ahead of the isMintedSpecPermanenceEnforced early
 * return, so the refusal is live even when minted-corpus enforcement is off.
 * Pins the structural facts; wording stays free.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { typeDefs } from './typeDefs.js';

const flat = (value: string) => value.replace(/\s+/g, ' ').toLowerCase();

function deleteAgentDescription(): string {
  const at = typeDefs.indexOf('deleteAgent(ref: ID!): Boolean!');
  expect(at).toBeGreaterThan(0);
  const from = typeDefs.lastIndexOf('Soft-delete an Agent', at);
  expect(from).toBeGreaterThanOrEqual(0);
  return flat(typeDefs.slice(from, at));
}

describe('#2331 — deleteAgent documents the DECISION_CONTAINED refusal', () => {
  it('names the code and the condition', () => {
    const block = deleteAgentDescription();
    expect(block).toContain('decision_contained');
    expect(block).toMatch(/system memory holds a decision or a decision log/);
  });

  it('distinguishes unconditional decision protection from conditional minted-content retention', () => {
    const block = deleteAgentDescription();
    expect(block).toContain('decision protection always applies');
    expect(block).toMatch(/if this server requires minted content to be retained, its separate deletion restrictions also apply/);
  });

  it('keeps the existing reference refusals', () => {
    const block = deleteAgentDescription();
    expect(block).toMatch(/live app install/);
    expect(block).toMatch(/extends it as its base/);
  });

  it('traces the live guard: the decision check precedes the enforcement early return', () => {
    const src = readFileSync(new URL('../../../lib/mintedSpecPermanence.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function assertNoMintedCorpusRemoval'));
    const decision = fn.indexOf('memoryHoldsDecisions');
    const early = fn.indexOf('isMintedSpecPermanenceEnforced()');
    expect(decision).toBeGreaterThan(0);
    expect(early).toBeGreaterThan(decision);
  });
});
