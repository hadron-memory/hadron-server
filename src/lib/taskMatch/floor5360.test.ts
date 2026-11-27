/**
 * #5360 B6 — direct unit pins for the no-match floor's env form (`src/lib/taskMatch/floor.ts`, #5284):
 * the decimal forms `TASK_MATCH_MIN_SCORE` accepts and rejects, and the `score === floor` boundary's
 * default. The boundary itself (a task at exactly the floor is MATCHED, `>=` not `>`) is pinned at the
 * resolver level in `resolvers.agentInstructions5284.test.ts` (#5360 "the floor boundary").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TASK_MATCH_MIN_SCORE_DEFAULT, taskMatchMinScore } from './floor.js';

describe('#5360 B6: TASK_MATCH_MIN_SCORE forms', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the default is 0.45 (the separating score of the re-cut S0 measurement, Holger 2026-11-25)', () => {
    expect(TASK_MATCH_MIN_SCORE_DEFAULT).toBe(0.45);
    expect(taskMatchMinScore()).toBe(TASK_MATCH_MIN_SCORE_DEFAULT);
  });

  it.each([
    ['0.45', 0.45],
    ['.5', 0.5],
    ['0.0001', 0.0001],
    ['0.9999', 0.9999],
    [' 0.5 ', 0.5], // surrounding whitespace is trimmed before the form is judged
    ['0.5\n', 0.5],
  ])('accepts %j as %d', async (raw, expected) => {
    vi.stubEnv('TASK_MATCH_MIN_SCORE', raw);
    expect(taskMatchMinScore()).toBe(expected);
  });

  it.each([
    '', '0', '1', 'abc', '-0.2', '1.5', '3e-1', '0x0', '00.5', '1.', '0.5.5', '+.5', '0,5', 'null', '0.45.',
  ])('falls back to the default on %j (no value switches the floor off or refuses every task)', (raw) => {
    vi.stubEnv('TASK_MATCH_MIN_SCORE', raw);
    expect(taskMatchMinScore()).toBe(TASK_MATCH_MIN_SCORE_DEFAULT);
  });
});
