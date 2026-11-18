/**
 * #1631: the small server-hosted pages of the passkey ceremonies (sign-in confirm, cancel link). Every page is
 * no-store, sends no referrer to any third party (a token may ride in its URL), and can't be framed (its button must
 * not be clickjacked). The policy is `same-origin`, NOT `no-referrer`: from a no-referrer page a browser sends a
 * non-GET request's Origin as "null", which the ceremony routes' Origin allowlist refuses (Chip's #2210 browser QA).
 * Same-origin requests carry the real Origin, and no referrer leaves the origin.
 */
import type { Response } from 'express';
import { ceremonyShell } from './ceremonyShell.js';

export const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

export const page = (title: string, body: string) => ceremonyShell({ title, body });

/** Send a page with the ceremony headers. */
export function sendPage(res: Response, status: number, title: string, body: string): void {
  res.status(status).set(PAGE_HEADERS).type('html').send(page(title, body));
}
