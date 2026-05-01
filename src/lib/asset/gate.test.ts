import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import {
  isAssetToolEnabled,
  assertAssetToolEnabled,
  ASSET_UPLOAD_TOOL_KEY,
  ToolNotEnabledError,
  assertMemoryAcceptsUploads,
  MemoryNotAcceptingUploadsError,
  MemoryNotFoundError,
} from './gate.js';

describe('asset / gate (v1 — per-App)', () => {
  it('exports the canonical tool key', () => {
    expect(ASSET_UPLOAD_TOOL_KEY).toBe('asset:upload');
  });

  describe('isAssetToolEnabled', () => {
    it('returns true when the key is in agentTools', () => {
      expect(isAssetToolEnabled({ agentTools: ['asset:upload'] })).toBe(true);
      expect(isAssetToolEnabled({ agentTools: ['h-find-node', 'asset:upload', 'h-read-node'] })).toBe(true);
    });

    it('returns false when the key is missing', () => {
      expect(isAssetToolEnabled({ agentTools: [] })).toBe(false);
      expect(isAssetToolEnabled({ agentTools: ['h-find-node'] })).toBe(false);
    });

    it('does not match a related-but-different key', () => {
      expect(isAssetToolEnabled({ agentTools: ['asset:list'] })).toBe(false);
      expect(isAssetToolEnabled({ agentTools: ['h-asset-request-upload'] })).toBe(false);
    });
  });

  describe('assertAssetToolEnabled', () => {
    it('returns silently when enabled', () => {
      expect(() => assertAssetToolEnabled({ agentTools: ['asset:upload'] })).not.toThrow();
    });

    it('throws ToolNotEnabledError when disabled', () => {
      expect(() => assertAssetToolEnabled({ agentTools: [] })).toThrow(ToolNotEnabledError);
      expect(() => assertAssetToolEnabled({ agentTools: ['h-find-node'] })).toThrow(/TOOL_NOT_ENABLED/);
    });

    it('attaches the tool key to the error', () => {
      try {
        assertAssetToolEnabled({ agentTools: [] });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ToolNotEnabledError);
        expect((e as ToolNotEnabledError).toolKey).toBe('asset:upload');
      }
    });
  });
});

// ─── v2: per-Memory gate ──────────────────────────────────────────────

describe('asset / gate (v2 — per-Memory)', () => {
  const db = new PrismaClient();
  let orgId: string;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.memory.deleteMany({ where: { name: { startsWith: 'gate-test-' } } });
    await db.organization.deleteMany({ where: { name: { startsWith: 'gate-test-' } } });
    const org = await db.organization.create({
      data: {
        name: 'gate-test-org',
        urn: `gate-test-org-${Date.now()}`,
      },
    });
    orgId = org.id;
  });

  describe('assertMemoryAcceptsUploads', () => {
    it('passes when the memory acceptsUploads = true', async () => {
      const memory = await db.memory.create({
        data: {
          organizationId: orgId,
          urn: `${orgId}:gate-test-mem-true`,
          name: 'gate-test-mem-true',
          class: 'knowledge',
          acceptsUploads: true,
        },
      });
      await expect(assertMemoryAcceptsUploads(db, memory.id)).resolves.toBeUndefined();
    });

    it('throws MemoryNotAcceptingUploadsError when the memory acceptsUploads = false', async () => {
      const memory = await db.memory.create({
        data: {
          organizationId: orgId,
          urn: `${orgId}:gate-test-mem-false`,
          name: 'gate-test-mem-false',
          class: 'knowledge',
          acceptsUploads: false,
        },
      });
      await expect(assertMemoryAcceptsUploads(db, memory.id))
        .rejects.toBeInstanceOf(MemoryNotAcceptingUploadsError);
    });

    it('throws MemoryNotFoundError for an unknown memory id', async () => {
      await expect(assertMemoryAcceptsUploads(db, 'this-id-does-not-exist'))
        .rejects.toBeInstanceOf(MemoryNotFoundError);
    });

    it('throws MemoryNotFoundError for a soft-deleted memory', async () => {
      const memory = await db.memory.create({
        data: {
          organizationId: orgId,
          urn: `${orgId}:gate-test-mem-deleted`,
          name: 'gate-test-mem-deleted',
          class: 'knowledge',
          acceptsUploads: true,
          deletedAt: new Date(),
        },
      });
      await expect(assertMemoryAcceptsUploads(db, memory.id))
        .rejects.toBeInstanceOf(MemoryNotFoundError);
    });
  });
});
