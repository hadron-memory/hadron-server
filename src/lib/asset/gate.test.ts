import { describe, it, expect } from 'vitest';
import {
  isAssetToolEnabled,
  assertAssetToolEnabled,
  ASSET_UPLOAD_TOOL_KEY,
  ToolNotEnabledError,
} from './gate.js';

describe('asset / gate', () => {
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
