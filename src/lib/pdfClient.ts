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

export interface PdfToMarkdownResult {
  markdown: string;
  /** Title from the PDF's metadata (info dict), when present. */
  title?: string;
  /** Number of pages the extractor processed. */
  pageCount: number;
}

/**
 * Base64 cap for inline PDF content (#488). A PDF is binary, so the inline
 * `content` String carries it base64-encoded; base64 inflates ~4/3, so this
 * ~9.5 MiB of text is ~7 MiB of PDF — comfortably under hadrontool-pdf's 10mb
 * MAX_BODY_SIZE (leaving room for the JSON envelope) so an oversized capture
 * fails as a clean typed error here instead of the tool's 413.
 */
export const MAX_PDF_BASE64_CHARS = 10_000_000;

/**
 * Extract Markdown from a base64-encoded PDF via hadrontool-pdf's
 * POST /convert/pdf-to-markdown (#488). The tool decodes the base64, validates
 * the %PDF- header, and pulls the text layer (no OCR) — so this client forwards
 * the base64 string rather than decoding it here. The documented contract is
 * raw base64 (the clipper strips the FileReader data-URL prefix), but a stray
 * `data:...;base64,` prefix is stripped defensively so a forgetful client gets
 * a clean result instead of a %PDF- 400 on garbage bytes. Scanned/image-only
 * PDFs extract to nothing and surface as a typed PDF_NO_TEXT error (OCR is out
 * of scope). Same config + error surface as convertHtmlToMarkdown.
 */
export async function convertPdfToMarkdown(pdfBase64: string): Promise<PdfToMarkdownResult> {
  // Tolerate a data-URL prefix even though the contract is raw base64.
  const rawBase64 = pdfBase64.replace(/^data:[^;,]*;base64,/, '');

  // Caller-error checks before infra checks: the cap applies regardless of
  // whether the service is configured.
  if (rawBase64.length > MAX_PDF_BASE64_CHARS) {
    throw new GraphQLError(
      `PDF content exceeds the ${MAX_PDF_BASE64_CHARS.toLocaleString('en-US')}-character (base64) conversion cap.`,
      { extensions: { code: 'PDF_TOO_LARGE', length: rawBase64.length, max: MAX_PDF_BASE64_CHARS } },
    );
  }
  const baseUrl = process.env.PDF_SERVICE_URL;
  if (!baseUrl) {
    throw new GraphQLError('PDF conversion is not configured (PDF_SERVICE_URL unset).', {
      extensions: { code: 'PDF_SERVICE_NOT_CONFIGURED' },
    });
  }
  const token = process.env.PDF_SERVICE_TOKEN;
  const url = `${baseUrl.replace(/\/+$/, '')}/convert/pdf-to-markdown`;

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
      body: JSON.stringify({ pdfBase64: rawBase64 }),
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

  const payload = (await res.json().catch(() => null)) as
    | { markdown?: string; pageCount?: number; info?: { title?: string } }
    | null;
  if (!payload || typeof payload.markdown !== 'string') {
    throw new GraphQLError('PDF service returned an unexpected response.', {
      extensions: { code: 'PDF_SERVICE_BAD_RESPONSE' },
    });
  }

  // Scanned/image-only PDFs (no text layer) extract to nothing — surface a
  // clear typed error rather than storing an empty node. OCR is out of scope.
  if (payload.markdown.trim() === '') {
    throw new GraphQLError(
      'No extractable text found in the PDF (it may be scanned or image-only).',
      { extensions: { code: 'PDF_NO_TEXT' } },
    );
  }

  // Type-check + trim: PDF metadata titles are often junk (whitespace, empty),
  // and a whitespace-only string would otherwise propagate as a blank title.
  const rawTitle = payload.info?.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  return {
    markdown: payload.markdown,
    pageCount: typeof payload.pageCount === 'number' ? payload.pageCount : 0,
    ...(title ? { title } : {}),
  };
}
