/**
 * The terminal and idle helpers that scripts/ticker-wake/ imports from ./router.ts (#2030, C6).
 *
 * The attention loop that used to drive these helpers is retired, and with it the tests that exercised them
 * through the loop. These are CHARACTERIZATION tests: every (screen, agent) pair those tests fed to
 * `idleProofAbovePrompt` and `promptIsEmptyFromTerm` (110 distinct cases from the 198 loop tests, including the
 * real captures named in the case titles) was recorded against the pre-retirement code and is now asserted
 * directly, so the idle and empty-prompt rules stay pinned without the loop. `expected` is the first element of
 * the helper's result; the human-readable reason text is not asserted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { idleProofAbovePrompt, promptIsEmptyFromTerm } from './router.js';

interface Case {
  k: 'idle' | 'pet';
  agent: string;
  input: string[] | Record<string, any> | undefined;
  expected: string | boolean;
  from: string[];
}

const CASES: Case[] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'screen-verdicts.json'), 'utf8'),
);

describe('idleProofAbovePrompt: the screen-proof idle verdict (recorded from the retired loop tests)', () => {
  const idle = CASES.filter((c) => c.k === 'idle');
  it('covers the recorded cases', () => expect(idle.length).toBeGreaterThanOrEqual(37));
  it.each(idle.map((c) => [`${c.agent}: ${c.from[0].slice(0, 110)}`, c] as const))('%s', (_n, c) => {
    expect(idleProofAbovePrompt(c.input as string[], c.agent)[0]).toBe(c.expected);
  });
});

describe('promptIsEmptyFromTerm: the empty-composer verdict (recorded from the retired loop tests)', () => {
  const pet = CASES.filter((c) => c.k === 'pet');
  it('covers the recorded cases', () => expect(pet.length).toBeGreaterThanOrEqual(73));
  it.each(pet.map((c) => [`${c.agent}: ${c.from[0].slice(0, 110)}`, c] as const))('%s', (_n, c) => {
    expect(promptIsEmptyFromTerm(c.input as Record<string, any> | undefined, c.agent)[0]).toBe(c.expected);
  });
});
