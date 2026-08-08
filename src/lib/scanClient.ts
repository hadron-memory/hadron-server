/**
 * Client for the malware-scan capability tool (hadrontool-scan). Mirrors
 * smsClient.ts / webSearchClient.ts: hadron-server stays the front door —
 * authorization and the upload-verification pipeline have already run
 * before anything here is called — and this module only ships an
 * already-authorized scan request to the internal tool, which streams the
 * bytes into its engine (ClamAV in v1) and returns a verdict.
 *
 * The tool holds NO object-storage credentials: `url` is a short-TTL
 * presigned GET minted by core on the promoted (never-presigned-for-PUT)
 * storage key, so the tool reads exactly the bytes the Asset row
 * references and nothing else.
 *
 * Contract (`scan@1`, provider-neutral so a hosted engine can swap in
 * without core changes):
 *   POST /ops/scan { url, sizeBytes?, filename? }
 *   → 200 { contract: "scan@1", verdict: "clean"|"infected"|"error",
 *           signature?, engine?: { name, version?, signatures? } }
 *
 * Configured by env:
 *   SCAN_TOOL_URL    e.g. http://hadrontool-scan:8080 (required)
 *   SCAN_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error posture: unlike the send-shaped clients this one never throws for
 * operational failures — a scan is idempotent and retried by the sweep, so
 * "tool unset / unreachable / engine error" all collapse into the
 * `unavailable` verdict and the asset simply stays PENDING. Only a
 * definitive engine verdict flips the row.
 */

/** How long one scan round-trip may take: fetch + engine pass at the
 * 25 MB platform cap comfortably fits; anything slower is treated as
 * unavailable and retried by the sweep. */
const SCAN_TIMEOUT_MS = 60_000;

export type ScanOutcome =
  | { verdict: 'clean' }
  | { verdict: 'infected'; signature: string | null }
  | { verdict: 'unavailable'; reason: string };

/**
 * Cheap config preflight — completeAssetUpload uses it to decide whether
 * the scanner path is in play at all (when unset, the legacy
 * HADRON_ASSET_SCAN_AUTO_CLEAN posture applies).
 */
export function isScanConfigured(): boolean {
  return Boolean(process.env.SCAN_TOOL_URL);
}

/**
 * Scan the bytes behind one presigned GET URL. Never throws: every
 * operational failure returns `{ verdict: 'unavailable' }` so callers
 * leave the row PENDING for the retry sweep.
 */
export async function scanUrl(input: {
  url: string;
  sizeBytes?: number;
  filename?: string;
}): Promise<ScanOutcome> {
  const baseUrl = process.env.SCAN_TOOL_URL;
  if (!baseUrl) {
    return { verdict: 'unavailable', reason: 'SCAN_TOOL_URL unset' };
  }
  const token = process.env.SCAN_TOOL_TOKEN || undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  let payload: Record<string, unknown> | null = null;
  let status: number;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/ops/scan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    status = res.status;
    // The body read stays INSIDE the timeout window (slackClient posture).
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body
      payload = null;
    }
  } catch (err) {
    return {
      verdict: 'unavailable',
      reason: controller.signal.aborted
        ? 'scan tool timed out'
        : `scan tool unreachable: ${String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (status !== 200 || !payload) {
    return {
      verdict: 'unavailable',
      reason: `scan tool answered ${status}${
        typeof payload?.error === 'string' ? ` (${payload.error})` : ''
      }`,
    };
  }

  // A DEFINITIVE verdict requires the contract discriminator: a
  // misrouted SCAN_TOOL_URL answering 200 { verdict: "clean" } from some
  // other service must not mark unscanned bytes CLEAN (PR-908 review,
  // Codex/Copilot). Error-shaped bodies are handled below regardless.
  if (payload.contract !== 'scan@1' && payload.verdict !== 'error') {
    return {
      verdict: 'unavailable',
      reason: `scan tool did not declare the scan@1 contract (got ${JSON.stringify(
        payload.contract ?? null,
      )})`,
    };
  }

  switch (payload.verdict) {
    case 'clean':
      return { verdict: 'clean' };
    case 'infected':
      return {
        verdict: 'infected',
        signature:
          typeof payload.signature === 'string'
            ? payload.signature.slice(0, 200)
            : null,
      };
    case 'error':
      return {
        verdict: 'unavailable',
        reason:
          typeof payload.message === 'string'
            ? `engine error: ${payload.message.slice(0, 300)}`
            : 'engine error',
      };
    default:
      return {
        verdict: 'unavailable',
        reason: 'scan tool returned an unexpected response shape',
      };
  }
}
