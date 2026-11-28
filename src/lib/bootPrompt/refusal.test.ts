/**
 * #2047 (S10, cor:agt:040:10) — the closed refusal code list, and the one refusal helper.
 */

import { describe, it, expect } from 'vitest';
import { GraphQLError } from 'graphql';
import { BOOT_PROMPT_REFUSAL_CODES, bootPromptRefusal, bootPromptRefusalCode } from './refusal.js';

describe('bootPromptRefusal', () => {
  it('has exactly the one agreed code list (#2045 / #2047), NOT_SET canonical', () => {
    expect([...BOOT_PROMPT_REFUSAL_CODES].sort()).toEqual(
      [
        'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE',
        'BOOT_PROMPT_NOT_SET',
        'BOOT_PROMPT_TARGET_DELETED',
        'BOOT_PROMPT_NOT_APPROVED',
        'BOOT_PROMPT_NOT_SIGNED',
        'BOOT_PROMPT_RECORDED_REVISION_DELETED',
      ].sort(),
    );
    expect(BOOT_PROMPT_REFUSAL_CODES).not.toContain('BOOT_PROMPT_MISSING');
  });

  it.each(['bind', 'chat', 'run'] as const)('is the same typed error on the %s surface', (surface) => {
    const err = bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', { surface, agentName: 'Mealplan' });
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions.code).toBe('BOOT_PROMPT_NOT_APPROVED');
    expect(err.extensions.surface).toBe(surface);
    expect(err.extensions.agentName).toBe('Mealplan');
  });

  it('carries no node, revision or pointer identity (an end-user chat refusal must not leak it)', () => {
    const err = bootPromptRefusal('BOOT_PROMPT_TARGET_DELETED', { surface: 'chat', agentName: 'Mealplan' });
    expect(Object.keys(err.extensions).sort()).toEqual(['agentName', 'code', 'surface']);
    expect(err.message).not.toMatch(/[0-9a-f]{8,}|hrn:|rev/i);
  });

  it('gives each code its own fixed message', () => {
    const messages = BOOT_PROMPT_REFUSAL_CODES.map(
      (code) => bootPromptRefusal(code, { surface: 'bind', agentName: 'A' }).message,
    );
    expect(new Set(messages).size).toBe(BOOT_PROMPT_REFUSAL_CODES.length);
  });
});

describe('bootPromptRefusalCode surface scoping (#3920)', () => {
  const run = bootPromptRefusal('BOOT_PROMPT_NOT_SET', { surface: 'run', agentName: 'a' });
  const bind = bootPromptRefusal('BOOT_PROMPT_NOT_SET', { surface: 'bind', agentName: 'a' });
  it('without a surface any boot-prompt refusal matches; with one only that surface does', () => {
    expect(bootPromptRefusalCode(run)).toBe('BOOT_PROMPT_NOT_SET');
    expect(bootPromptRefusalCode(bind)).toBe('BOOT_PROMPT_NOT_SET');
    expect(bootPromptRefusalCode(run, 'run')).toBe('BOOT_PROMPT_NOT_SET');
    expect(bootPromptRefusalCode(bind, 'run')).toBeNull();
    expect(bootPromptRefusalCode(new Error('x'), 'run')).toBeNull();
    expect(bootPromptRefusalCode(new GraphQLError('x', { extensions: { code: 'OTHER', surface: 'run' } }), 'run')).toBeNull();
  });
});
