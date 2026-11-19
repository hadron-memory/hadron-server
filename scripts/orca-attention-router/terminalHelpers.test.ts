/**
 * Characterization tests for the idle and empty-prompt helpers that scripts/ticker-wake/ imports from ./router.ts
 * (#2030, C6).
 *
 * The attention loop that used to drive these helpers is retired, and with it the tests that exercised them
 * through the loop. This file covers exactly the (screen, agent) pairs those loop tests REACHED `idleProofAbovePrompt`
 * and `promptIsEmptyFromTerm` with: 110 distinct cases (37 idle-proof, 73 prompt-empty), recorded against the
 * pre-retirement code, including the real captures named in the case titles. `expected` is the first element of
 * the helper's result; the reason text is not asserted.
 *
 * What it does NOT cover, and where that lives: the pure `promptLineIsEmpty` unit cases (#5473, #1555, #5724) and the
 * `loadConfig` validation cases are restored verbatim in router.test.ts, with the cli#907 captures and the
 * `screenAgentFamily` cases. `resolveTerminal`, `listTerminals`, `teamBinding`, `readScreen` and `isIdle` have no
 * direct tests here; ticker-wake's own suite covers how it uses them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { idleProofAbovePrompt, promptIsEmptyFromTerm } from './router.js';

interface Case {
  k: 'idleProof' | 'promptEmpty';
  agent: string;
  input: string[] | Record<string, unknown> | null;
  expected: 'idle' | 'busy' | 'unknown' | boolean;
  from: string[];
}

const CASES: Case[] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'screen-verdicts.json'), 'utf8'),
);

describe('idleProofAbovePrompt: the screen-proof idle verdict (recorded from the retired loop tests)', () => {
  const idle = CASES.filter((c) => c.k === 'idleProof');
  it('covers the recorded cases', () => expect(idle.length).toBe(37));
  it.each(idle.map((c) => [`${c.agent}: ${c.from[0].slice(0, 110)}`, c] as const))('%s', (_n, c) => {
    expect(idleProofAbovePrompt(c.input as string[], c.agent)[0]).toBe(c.expected);
  });
});

describe('promptIsEmptyFromTerm: the empty-composer verdict (recorded from the retired loop tests)', () => {
  const pet = CASES.filter((c) => c.k === 'promptEmpty');
  it('covers the recorded cases', () => expect(pet.length).toBe(73));
  it.each(pet.map((c) => [`${c.agent}: ${c.from[0].slice(0, 110)}`, c] as const))('%s', (_n, c) => {
    expect(promptIsEmptyFromTerm((c.input ?? undefined) as Record<string, any> | undefined, c.agent)[0]).toBe(c.expected);
  });
});
