import { describe, expect, it } from 'vitest';
import {
  MemoryDeletedError,
  MemoryUrnOccupiedByDeletedError,
  ProtectedMemoryError,
} from './errors.js';

describe('MemoryDeletedError', () => {
  const id = 'mem_abc';
  const deletedAt = new Date('2026-05-01T12:00:00.000Z');

  it('carries memoryId, deletedAt, deleterName, and a stable code', () => {
    const err = new MemoryDeletedError(id, deletedAt, 'Alice');
    expect(err.code).toBe('MEMORY_DELETED');
    expect(err.memoryId).toBe(id);
    expect(err.deletedAt).toBe(deletedAt);
    expect(err.deleterName).toBe('Alice');
    expect(err.name).toBe('MemoryDeletedError');
  });

  it('renders deleter name in the message when provided', () => {
    const err = new MemoryDeletedError(id, deletedAt, 'Alice');
    expect(err.message).toContain('Alice');
    expect(err.message).toContain(deletedAt.toISOString());
    expect(err.message.startsWith('MEMORY_DELETED:')).toBe(true);
  });

  it('falls back to "[unknown]" when deleter name is null', () => {
    const err = new MemoryDeletedError(id, deletedAt, null);
    expect(err.deleterName).toBeNull();
    expect(err.message).toContain('[unknown]');
  });
});

describe('ProtectedMemoryError', () => {
  it('carries the protected class and surfaces the alternative-path message verbatim', () => {
    const message =
      'Cannot delete an app memory directly. The memory is removed automatically when its App is deleted.';
    const err = new ProtectedMemoryError('mem_app', 'app', message);
    expect(err.code).toBe('PROTECTED_MEMORY');
    expect(err.memoryClass).toBe('app');
    expect(err.message).toBe(`PROTECTED_MEMORY: ${message}`);
  });

  it('preserves the agent-system alternative-path message exactly (existing rule)', () => {
    const original =
      'Cannot delete an agent system memory directly. Delete the owning agent instead.';
    const err = new ProtectedMemoryError('mem_sys', 'agent_system', original);
    expect(err.message.endsWith(original)).toBe(true);
  });
});

describe('MemoryUrnOccupiedByDeletedError', () => {
  const urn = 'acme.test:notes';
  const occupyingId = 'mem_xyz';
  const deletedAt = new Date('2026-05-04T09:30:00.000Z');

  it('carries urn, occupyingMemoryId, and deletedAt', () => {
    const err = new MemoryUrnOccupiedByDeletedError(urn, occupyingId, deletedAt);
    expect(err.code).toBe('MEMORY_URN_OCCUPIED_BY_DELETED');
    expect(err.urn).toBe(urn);
    expect(err.occupyingMemoryId).toBe(occupyingId);
    expect(err.deletedAt).toBe(deletedAt);
  });

  it('points the caller at the two resolution paths in the message', () => {
    const err = new MemoryUrnOccupiedByDeletedError(urn, occupyingId, deletedAt);
    expect(err.message).toContain(urn);
    expect(err.message).toContain('Restore');
    expect(err.message.toLowerCase()).toContain('retention sweep');
  });
});
