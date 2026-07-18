/**
 * Unit tests for the shared NodeRevision snapshot builder (#620): the editor
 * split (editedBy = User PK only; everything else → editedByInfo), the
 * revLabel/changes capture, and the diffNodeChanges field comparison.
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import {
  buildNodeRevisionSnapshot,
  editorFromAuth,
  diffNodeChanges,
  type SnapshotSourceNode,
} from './nodeRevisionSnapshot.js';

const NODE: SnapshotSourceNode = {
  id: 'n1',
  memoryId: 'm1',
  loc: 'a:b',
  name: 'B',
  alias: null,
  description: 'desc',
  abstract: 'abs',
  abstractOriginHash: 'ffffffff',
  content: 'body',
  tags: ['x'],
  nodeType: 'info',
  objectType: null,
  isLink: false,
  properties: { k: 1 },
  data: null,
  seq: 3,
  isRunnable: null,
  llmModel: null,
  aiAgent: 'claude-code',
};

describe('editorFromAuth (#620)', () => {
  it('captures a user principal as editedBy only', () => {
    expect(editorFromAuth({ userId: 'u1', clientId: 'github:someone' })).toEqual({
      userId: 'u1',
      info: null,
    });
  });

  it('captures an OAuth identity string when no user id resolves', () => {
    expect(editorFromAuth({ clientId: 'github:someone' })).toEqual({
      userId: null,
      info: 'github:someone',
    });
  });

  it('captures an App-key principal as app:<id>', () => {
    expect(editorFromAuth({ appId: 'app-1' })).toEqual({ userId: null, info: 'app:app-1' });
  });

  it('captures nothing for an anonymous context', () => {
    expect(editorFromAuth({})).toEqual({ userId: null, info: null });
  });
});

describe('buildNodeRevisionSnapshot (#620)', () => {
  it('captures the full curated subset including the new fields', () => {
    const snap = buildNodeRevisionSnapshot(NODE, { userId: 'u1' });
    expect(snap).toMatchObject({
      nodeId: 'n1',
      memoryId: 'm1',
      loc: 'a:b',
      name: 'B',
      abstract: 'abs',
      abstractOriginHash: 'ffffffff',
      content: 'body',
      tags: ['x'],
      nodeType: 'info',
      objectType: null,
      isLink: false,
      properties: { k: 1 },
      seq: 3,
      aiAgent: 'claude-code',
      editedBy: 'u1',
      editedByInfo: null,
      revLabel: null,
      changes: [],
      createdBy: 'u1',
    });
    // Json null must be DbNull for Prisma writes.
    expect(snap.data).toBe(Prisma.DbNull);
  });

  it('records revLabel (the #88 reason) and changes', () => {
    const snap = buildNodeRevisionSnapshot(NODE, { userId: 'u1' }, {
      revLabel: 'why not',
      changes: ['content', 'tags'],
    });
    expect(snap.revLabel).toBe('why not');
    expect(snap.changes).toEqual(['content', 'tags']);
  });

  it('truncates an over-long revLabel instead of failing the edit', () => {
    const snap = buildNodeRevisionSnapshot(NODE, { userId: 'u1' }, {
      revLabel: 'r'.repeat(600),
    });
    expect(snap.revLabel).toHaveLength(500);
  });

  it('routes a user-less principal to editedByInfo (editedBy stays null)', () => {
    const snap = buildNodeRevisionSnapshot(NODE, editorFromAuth({ appId: 'app-9' }));
    expect(snap.editedBy).toBeNull();
    expect(snap.editedByInfo).toBe('app:app-9');
    expect(snap.createdBy).toBe('app:app-9');
  });
});

describe('diffNodeChanges (#620)', () => {
  it('reports only supplied-and-different fields', () => {
    expect(
      diffNodeChanges(NODE, { name: 'B2', description: 'desc', abstract: undefined }),
    ).toEqual(['name']);
  });

  it('compares arrays and JSON structurally', () => {
    expect(diffNodeChanges(NODE, { tags: ['x'] })).toEqual([]);
    expect(diffNodeChanges(NODE, { tags: ['x', 'y'] })).toEqual(['tags']);
    expect(diffNodeChanges(NODE, { properties: { k: 1 } })).toEqual([]);
    expect(diffNodeChanges(NODE, { properties: { k: 2 } })).toEqual(['properties']);
  });

  it('ignores JSON object key order (Postgres JSONB reorders keys)', () => {
    const stored = { ...NODE, properties: { zebra: 1, alpha: { b: 2, a: 1 } } };
    expect(
      diffNodeChanges(stored, { properties: { alpha: { a: 1, b: 2 }, zebra: 1 } }),
    ).toEqual([]);
    // Array element order stays significant — order is data.
    expect(diffNodeChanges({ ...NODE, tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toEqual(['tags']);
  });

  it('treats null vs value as a change, null vs null as none', () => {
    expect(diffNodeChanges(NODE, { alias: null })).toEqual([]);
    expect(diffNodeChanges(NODE, { alias: 'A' })).toEqual(['alias']);
    expect(diffNodeChanges(NODE, { content: null })).toEqual(['content']);
  });

  it('ignores keys outside the versioned field set', () => {
    expect(diffNodeChanges(NODE, { reason: 'meta', edges: [], contentHash: 'zz' })).toEqual([]);
  });

  it('reports move-style addressing changes', () => {
    expect(diffNodeChanges(NODE, { loc: 'c:d', memoryId: 'm1' })).toEqual(['loc']);
  });
});
