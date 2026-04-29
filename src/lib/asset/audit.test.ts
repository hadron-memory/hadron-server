import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logAssetEvent } from './audit.js';

describe('logAssetEvent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits a structured JSON line with eventType=asset', () => {
    logAssetEvent({
      operation: 'upload-completed',
      assetId: 'asset-1',
      agentId: 'agent-1',
      memoryId: 'mem-1',
      userId: 'user-1',
      appId: 'app-1',
      bytes: 12345,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.level).toBe('info');
    expect(line.eventType).toBe('asset');
    expect(line.operation).toBe('upload-completed');
    expect(line.assetId).toBe('asset-1');
    expect(line.bytes).toBe(12345);
    expect(typeof line.ts).toBe('string');
  });

  it('omits undefined fields naturally', () => {
    logAssetEvent({ operation: 'upload-requested' });
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.assetId).toBeUndefined();
    expect(line.bytes).toBeUndefined();
  });
});
