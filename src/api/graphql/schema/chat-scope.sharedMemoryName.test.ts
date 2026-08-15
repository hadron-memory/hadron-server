/**
 * #995 — the shared app-class memory's display name.
 *
 * Both segments carry information when App and Agent are named differently, but
 * for a team App they are normally identical (the getting-started sequence
 * installs an agent called "MM Eng Team" under the name "MM Eng Team"), so
 * composing blindly stuttered by default.
 */
import { describe, it, expect } from 'vitest';
import { sharedMemoryName } from './chat-scope.js';

describe('#995 — sharedMemoryName', () => {
  it('collapses the duplicate segment when App and Agent share a name', () => {
    expect(sharedMemoryName('MM Eng Team', 'MM Eng Team')).toBe('MM Eng Team — shared chats');
  });

  it('keeps both segments when they differ — each carries information', () => {
    expect(sharedMemoryName('Eng Team WL', 'Second Agent')).toBe(
      'Eng Team WL — Second Agent — shared chats',
    );
  });

  it('compares EXACTLY — a deliberate case difference is preserved', () => {
    // A fuzzy compare would collapse this; exact match keeps a distinction
    // someone may have made on purpose. Documented as the conservative choice.
    expect(sharedMemoryName('MM Eng Team', 'MM Eng team')).toBe(
      'MM Eng Team — MM Eng team — shared chats',
    );
  });

  it('applies the collapse at the LABEL level, so other kinds inherit it', () => {
    expect(sharedMemoryName('Team', 'Team', 'shared notes')).toBe('Team — shared notes');
    expect(sharedMemoryName('App', 'Agent', 'shared notes')).toBe(
      'App — Agent — shared notes',
    );
  });
});
