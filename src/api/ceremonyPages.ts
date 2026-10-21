/**
 * #1631: the small server-hosted pages of the passkey ceremonies (sign-in confirm, cancel link). Every page is
 * no-store, sends no referrer (a token or leg may ride in its URL), and can't be framed (its button must not be
 * clickjacked).
 */
import type { Response } from 'express';

export const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

export const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">${body}</body></html>`;

/** Send a page with the ceremony headers. */
export function sendPage(res: Response, status: number, title: string, body: string): void {
  res.status(status).set(PAGE_HEADERS).type('html').send(page(title, body));
}
