import { describe, expect, it } from 'vitest';
import {
  assertMemoryClassDeletable,
  type ClassEligibilityInput,
} from './classEligibility.js';
import { ProtectedMemoryError } from './errors.js';

const baseId = 'mem_abc';

const make = (
  overrides: Partial<ClassEligibilityInput>,
): ClassEligibilityInput => ({
  id: baseId,
  type: 'KNOWLEDGE',
  class: 'knowledge',
  ...overrides,
});

describe('assertMemoryClassDeletable', () => {
  it('passes silently for knowledge-class memories', () => {
    expect(() => assertMemoryClassDeletable(make({ class: 'knowledge' }))).not.toThrow();
  });

  it('rejects agent-system memories with the existing alternative-path message', () => {
    let caught: ProtectedMemoryError | null = null;
    try {
      assertMemoryClassDeletable(make({ type: 'AGENT_SYSTEM', class: 'system' }));
    } catch (e) {
      caught = e as ProtectedMemoryError;
    }
    expect(caught).toBeInstanceOf(ProtectedMemoryError);
    expect(caught?.code).toBe('PROTECTED_MEMORY');
    expect(caught?.memoryClass).toBe('agent_system');
    expect(caught?.message).toContain(
      'Cannot delete an agent system memory directly. Delete the owning agent instead.',
    );
  });

  it('treats type=AGENT_SYSTEM as protected even if class is mis-set', () => {
    // Defense in depth: legacy rows could have a mismatched type/class pairing.
    expect(() =>
      assertMemoryClassDeletable(make({ type: 'AGENT_SYSTEM', class: 'knowledge' })),
    ).toThrow(ProtectedMemoryError);
  });

  it('treats class=system as protected even when type=KNOWLEDGE', () => {
    expect(() =>
      assertMemoryClassDeletable(make({ type: 'KNOWLEDGE', class: 'system' })),
    ).toThrow(ProtectedMemoryError);
  });

  it('rejects app memories pointing at the App.delete pivot', () => {
    let caught: ProtectedMemoryError | null = null;
    try {
      assertMemoryClassDeletable(make({ class: 'app' }));
    } catch (e) {
      caught = e as ProtectedMemoryError;
    }
    expect(caught).toBeInstanceOf(ProtectedMemoryError);
    expect(caught?.memoryClass).toBe('app');
    expect(caught?.message).toContain(
      'Cannot delete an app memory directly. The memory is removed automatically when its App is deleted.',
    );
  });

  it('rejects personal memories pointing at the owning user', () => {
    let caught: ProtectedMemoryError | null = null;
    try {
      assertMemoryClassDeletable(make({ class: 'personal' }));
    } catch (e) {
      caught = e as ProtectedMemoryError;
    }
    expect(caught).toBeInstanceOf(ProtectedMemoryError);
    expect(caught?.memoryClass).toBe('personal');
    expect(caught?.message).toContain('owning user must delete it');
  });

  it('preserves memoryId on the thrown error for downstream logging', () => {
    let caught: ProtectedMemoryError | null = null;
    try {
      assertMemoryClassDeletable(make({ id: 'mem_xyz', class: 'app' }));
    } catch (e) {
      caught = e as ProtectedMemoryError;
    }
    expect(caught?.memoryId).toBe('mem_xyz');
  });
});
