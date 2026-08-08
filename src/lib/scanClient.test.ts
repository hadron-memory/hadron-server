/**
 * scanClient — contract-shape and failure-posture tests. The client
 * must NEVER throw for operational failures: every non-verdict path
 * collapses to `unavailable` so the asset stays PENDING for the sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isScanConfigured, scanUrl } from './scanClient.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.stubEnv('SCAN_TOOL_URL', 'http://hadrontool-scan:8080');
  vi.stubEnv('SCAN_TOOL_TOKEN', 'sekrit');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('isScanConfigured', () => {
  it('reflects SCAN_TOOL_URL presence', () => {
    expect(isScanConfigured()).toBe(true);
    vi.stubEnv('SCAN_TOOL_URL', '');
    expect(isScanConfigured()).toBe(false);
  });
});

describe('scanUrl', () => {
  it('returns clean for a clean verdict and sends the bearer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { contract: 'scan@1', verdict: 'clean' }),
    );
    const out = await scanUrl({ url: 'https://bucket/x', sizeBytes: 10 });
    expect(out).toEqual({ verdict: 'clean' });
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('http://hadrontool-scan:8080/ops/scan');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer sekrit',
    );
  });

  it('returns infected with the signature name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        contract: 'scan@1',
        verdict: 'infected',
        signature: 'Eicar-Signature',
      }),
    );
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out).toEqual({ verdict: 'infected', signature: 'Eicar-Signature' });
  });

  it('tolerates an infected verdict without a signature', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { contract: 'scan@1', verdict: 'infected' }),
    );
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out).toEqual({ verdict: 'infected', signature: null });
  });

  it('maps an engine error verdict to unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        contract: 'scan@1',
        verdict: 'error',
        message: 'clamd connection refused',
      }),
    );
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out.verdict).toBe('unavailable');
  });

  it('maps a non-200 answer to unavailable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'booting' }));
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out.verdict).toBe('unavailable');
  });

  it('maps network failure to unavailable instead of throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out.verdict).toBe('unavailable');
  });

  it('maps an unexpected response shape to unavailable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { verdict: 'maybe' }));
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out.verdict).toBe('unavailable');
  });

  it('refuses a definitive verdict that does not declare the scan@1 contract', async () => {
    // A misrouted SCAN_TOOL_URL answering 200 {verdict:"clean"} from some
    // other service must not mark unscanned bytes CLEAN.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { verdict: 'clean' }));
    expect((await scanUrl({ url: 'https://bucket/x' })).verdict).toBe('unavailable');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { contract: 'scan@2', verdict: 'infected', signature: 'X' }),
    );
    expect((await scanUrl({ url: 'https://bucket/x' })).verdict).toBe('unavailable');
  });

  it('is unavailable when SCAN_TOOL_URL is unset (never fetches)', async () => {
    vi.stubEnv('SCAN_TOOL_URL', '');
    const out = await scanUrl({ url: 'https://bucket/x' });
    expect(out.verdict).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
