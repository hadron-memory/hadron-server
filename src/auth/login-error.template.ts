/**
 * Human-readable failure page for the first-party login callbacks
 * (GitHub / Google / Apple), in the same minimal-CSS family as
 * `consent.template.ts` / `email-entry.template.ts`.
 *
 * These endpoints are only ever hit by browsers (the IdP redirects or
 * form-POSTs the user's browser to them), so a raw-JSON 400 body was a
 * dead end for the human standing there — App Review reported it as
 * "the app failed to login" with nothing to go on. The page is static
 * and deliberately free of technical detail; the diagnostic lives in
 * the server log (`failLoginCallback` below), which is what makes the
 * next opaque App-Review report diagnosable.
 *
 * Styling note (issue #318 / the forced-dark-contrast finding): every
 * surface pins its own `color` next to its non-default `background`,
 * and the palette is expressed as scheme-matched CSS-variable pairs, so
 * a forced/auto dark mode can never split a fg/bg pair into an
 * unreadable combination. Keep that property when editing.
 */

import type { Response } from 'express';

export const LOGIN_ERROR_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign-in didn&#39;t complete</title>
  <style>
    /* Matched light/dark pairs via custom properties (issue #318). */
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --card-bg: #fff;
      --card-border: #e5e5e5;
      --text: #1c1c1c;
      --muted: #666;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1c1c;
        --card-bg: #262626;
        --card-border: #333;
        --text: #e6e6e6;
        --muted: #9a9a9a;
      }
    }
    body {
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; padding: 2rem 1rem;
      background: var(--bg); color: var(--text);
      display: flex; justify-content: center;
    }
    main {
      max-width: 480px; width: 100%;
      background: var(--card-bg); color: var(--text);
      border: 1px solid var(--card-border); border-radius: 8px;
      padding: 1.5rem 2rem;
    }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Sign-in didn&#39;t complete</h1>
    <p>Your sign-in session expired or was interrupted. Please return to the app and try again.</p>
  </main>
</body>
</html>
`;

/**
 * Short, stable reason codes for the server log — the ONLY diagnostic
 * surface these failures have (the browser page is deliberately vague,
 * and App Review reports arrive with no client-side logs).
 */
export type LoginFailureReason =
  | 'state_missing'
  | 'state_unknown'
  | 'state_expired'
  | 'state_claim_failed'
  | 'exchange_failed'
  | 'verify_failed'
  | 'org_membership_denied'
  | 'internal_error';

/**
 * Log a login-callback failure (provider + reason + at most the error
 * MESSAGE — never tokens, authorization codes, or emails; our auth
 * modules throw static-string messages) and answer the friendly page.
 * State failures keep their historical 400; exchange/verify/internal
 * failures keep their historical 500.
 */
export function failLoginCallback(
  res: Response,
  provider: string,
  reason: LoginFailureReason,
  opts: { status?: number; err?: unknown } = {},
): void {
  const detail =
    opts.err === undefined
      ? ''
      : ` — ${opts.err instanceof Error ? opts.err.message : String(opts.err)}`;
  console.error(`[auth] ${provider} login callback failed: ${reason}${detail}`);
  res.status(opts.status ?? 400).type('html').send(LOGIN_ERROR_TEMPLATE);
}
