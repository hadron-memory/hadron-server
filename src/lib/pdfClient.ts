import { GraphQLError } from 'graphql';

/**
 * Client for the internal hadrontool-pdf service (markdown -> PDF).
 *
 * hadron-server stays the front door: it has already run access control and
 * decrypted the node before calling here. This module only ships the rendered
 * Markdown to the stateless renderer and returns base64 PDF bytes. The renderer
 * is internal-only (not exposed to the cloud); auth is a shared bearer token.
 *
 * Configured by env:
 *   PDF_SERVICE_URL    base URL, e.g. http://hadrontool-pdf:8080 (required)
 *   PDF_SERVICE_TOKEN  bearer token (optional; sent when set)
 */

export interface PdfRenderResult {
  /** base64-encoded PDF bytes */
  base64: string;
  /** decoded byte length of the PDF */
  bytes: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function renderMarkdownToPdf(
  markdown: string,
  opts?: { title?: string },
): Promise<PdfRenderResult> {
  const baseUrl = process.env.PDF_SERVICE_URL;
  if (!baseUrl) {
    throw new GraphQLError('PDF export is not configured (PDF_SERVICE_URL unset).', {
      extensions: { code: 'PDF_SERVICE_NOT_CONFIGURED' },
    });
  }
  const token = process.env.PDF_SERVICE_TOKEN;
  const url = `${baseUrl.replace(/\/+$/, '')}/convert/markdown-to-pdf?format=base64`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ markdown, options: opts?.title ? { title: opts.title } : {} }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(
      timedOut ? 'PDF service timed out.' : 'PDF service is unreachable.',
      { extensions: { code: 'PDF_SERVICE_UNREACHABLE', cause: String(err) } },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GraphQLError(`PDF service error (${res.status}).`, {
      extensions: { code: 'PDF_SERVICE_ERROR', status: res.status, detail: detail.slice(0, 500) },
    });
  }

  const payload = (await res.json().catch(() => null)) as { pdfBase64?: string; bytes?: number } | null;
  if (!payload || typeof payload.pdfBase64 !== 'string') {
    throw new GraphQLError('PDF service returned an unexpected response.', {
      extensions: { code: 'PDF_SERVICE_BAD_RESPONSE' },
    });
  }

  return {
    base64: payload.pdfBase64,
    bytes: payload.bytes ?? Buffer.byteLength(payload.pdfBase64, 'base64'),
  };
}

export interface HtmlToMarkdownResult {
  markdown: string;
  /** Title the converter extracted from the HTML (e.g. <title>), when any. */
  title?: string;
}

/**
 * Input cap mirrored from hadrontool-pdf's MAX_HTML_CHARS — validated here so
 * an oversized capture fails as a clean typed error instead of surfacing the
 * tool's 413 (#476; hadron-server's express.json allows 25mb, the tool 5M
 * chars).
 */
export const MAX_HTML_CHARS = 5_000_000;

/**
 * Convert captured HTML to Markdown via hadrontool-pdf's
 * POST /convert/html-to-markdown (#476, spec cor:cnv:010:01). The service
 * sanitizes (scripts/styles/handlers, non-http(s) URLs) and converts via
 * turndown+GFM — no double-sanitizing needed here. Main-content extraction is
 * NOT performed (cor:cnv:010:00): callers pass reader-mode-extracted content.
 * Same config + error surface as renderMarkdownToPdf.
 */
export async function convertHtmlToMarkdown(
  html: string,
  opts?: { title?: string },
): Promise<HtmlToMarkdownResult> {
  // Caller-error checks before infra checks: the cap applies regardless of
  // whether the service is configured.
  if (html.length > MAX_HTML_CHARS) {
    throw new GraphQLError(
      `HTML content exceeds the ${MAX_HTML_CHARS.toLocaleString('en-US')}-character conversion cap.`,
      { extensions: { code: 'HTML_TOO_LARGE', length: html.length, max: MAX_HTML_CHARS } },
    );
  }
  const baseUrl = process.env.PDF_SERVICE_URL;
  if (!baseUrl) {
    throw new GraphQLError('HTML conversion is not configured (PDF_SERVICE_URL unset).', {
      extensions: { code: 'PDF_SERVICE_NOT_CONFIGURED' },
    });
  }
  const token = process.env.PDF_SERVICE_TOKEN;
  const url = `${baseUrl.replace(/\/+$/, '')}/convert/html-to-markdown`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ html, options: opts?.title ? { title: opts.title } : {} }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(
      timedOut ? 'PDF service timed out.' : 'PDF service is unreachable.',
      { extensions: { code: 'PDF_SERVICE_UNREACHABLE', cause: String(err) } },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GraphQLError(`PDF service error (${res.status}).`, {
      extensions: { code: 'PDF_SERVICE_ERROR', status: res.status, detail: detail.slice(0, 500) },
    });
  }

  const payload = (await res.json().catch(() => null)) as { markdown?: string; title?: string } | null;
  if (!payload || typeof payload.markdown !== 'string') {
    throw new GraphQLError('PDF service returned an unexpected response.', {
      extensions: { code: 'PDF_SERVICE_BAD_RESPONSE' },
    });
  }
  return { markdown: payload.markdown, ...(payload.title ? { title: payload.title } : {}) };
}
