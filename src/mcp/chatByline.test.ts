import { describe, it, expect } from 'vitest';
import { chatByline } from './chatByline.js';

describe('chatByline (#1791, Riana P3)', () => {
  it('marks the platform by authorSystem, not by name', () => {
    expect(chatByline({ authorName: 'Hadron (platform)', authorSystem: true })).toBe('⟦Hadron (platform)⟧');
  });
  it('a Worker named like the platform does not read as the platform', () => {
    const worker = chatByline({ authorName: 'Hadron (platform)', authorSystem: false });
    expect(worker).toBe('[Hadron (platform)]');
    expect(worker).not.toBe(chatByline({ authorName: 'Hadron (platform)', authorSystem: true }));
  });
  it('a Worker cannot carry the platform brackets into its own byline', () => {
    expect(chatByline({ authorName: '⟦Hadron (platform)⟧', authorSystem: false })).toBe('[(Hadron (platform))]');
  });
  it('keeps free-form names and the unknown fallback', () => {
    expect(chatByline({ authorName: 'liam' })).toBe('[liam]');
    expect(chatByline({})).toBe('[unknown]');
  });
});
