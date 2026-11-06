/**
 * #804 — OAuth email magic-link sign-in: server-hosted pages.
 *
 * Two templates in the same minimal-CSS family as
 * `consent.template.ts` (spec 025 T037):
 *
 *   - `EMAIL_ENTRY_TEMPLATE` — rendered by `GET /oauth/authorize` when
 *     the caller is unauthenticated and selected `login_provider=email`.
 *     The form POSTs the address to `/oauth/authorize/email` together
 *     with the CSRF token and a hidden `return_to` carrying the FULL
 *     original authorize URL, so the magic link can land the user back
 *     on `/oauth/authorize` after the cookie is set.
 *   - `EMAIL_SENT_TEMPLATE` — the "Check your email" page rendered
 *     after a successful send.
 *
 * The placeholders (`{{name}}`) are substituted by `renderTemplate` in
 * `oauth.ts`. ALL values are HTML-escaped before substitution — the
 * templates have no raw-insertion points.
 *
 * Styling note (issue #318 / the forced-dark-contrast finding): every
 * surface pins its own `color` next to its non-default `background`,
 * and the palette is expressed as scheme-matched CSS-variable pairs, so
 * a forced/auto dark mode can never split a fg/bg pair into an
 * unreadable combination. Keep that property when editing.
 *
 * Form action and middleware ordering must stay in sync with the
 * router in `oauth.ts`:
 *   - POST `/oauth/authorize/email` ← rate limit ← `express.urlencoded`
 *     ← `csrf-csrf` ← `handleAuthorizeEmailPost`.
 *   - The hidden `_csrf` input MUST match the cookie set by the
 *     `generateCsrfToken` call in the GET handler's email branch.
 */

/** Shared <style> block for both pages — the consent screen's palette. */
export const SHARED_STYLE = `  <style>
    /* Matched light/dark pairs via custom properties (issue #318): a
       background and its foreground can never resolve to different
       schemes, even under a forced/auto dark transformation. */
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --card-bg: #fff;
      --card-border: #e5e5e5;
      --text: #1c1c1c;
      --muted: #666;
      --input-bg: #fff;
      --input-border: #ccc;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1c1c;
        --card-bg: #262626;
        --card-border: #333;
        --text: #e6e6e6;
        --muted: #9a9a9a;
        --input-bg: #1c1c1c;
        --input-border: #555;
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
    p.muted { color: var(--muted); font-size: 0.9em; }
    form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
    label { font-weight: 500; font-size: 0.95em; }
    input[type="email"] {
      font: inherit;
      padding: 0.6rem 0.75rem;
      border-radius: 6px; border: 1px solid var(--input-border);
      background: var(--input-bg); color: var(--text);
    }
    button[type="submit"] {
      padding: 0.6rem 1rem;
      font: inherit; font-weight: 500;
      border-radius: 6px; border: 0;
      cursor: pointer;
      background: #0a66ff; color: #fff;
    }
    button[type="submit"]:hover { background: #0855d0; }
    a.button {
      display: inline-block; margin-top: 1.5rem;
      padding: 0.6rem 1rem;
      font: inherit; font-weight: 500; text-decoration: none;
      border-radius: 6px;
      background: #0a66ff; color: #fff;
    }
    a.button:hover { background: #0855d0; }
  </style>`;

export const EMAIL_ENTRY_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in to Hadron</title>
${SHARED_STYLE}
</head>
<body>
  <main>
    <h1>Sign in to Hadron</h1>
    <p>Enter your email address and we&#39;ll send you a sign-in link, so you can continue authorizing <strong>{{clientName}}</strong>.</p>
    <form method="post" action="/oauth/authorize/email">
      <input type="hidden" name="_csrf"     value="{{csrfToken}}">
      <input type="hidden" name="return_to" value="{{returnTo}}">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required autofocus
             autocomplete="email" placeholder="you@example.com" maxlength="320">
      <button type="submit">Send sign-in link</button>
    </form>
  </main>
</body>
</html>
`;

export const EMAIL_SENT_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Check your email</title>
${SHARED_STYLE}
</head>
<body>
  <main>
    <h1>Check your email</h1>
    <p>We sent a sign-in link to <strong>{{email}}</strong>.</p>
    <p>Open the link on this device to continue — after signing in you&#39;ll be asked to finish authorizing the application.</p>
    <p class="muted">The link expires in {{expiryMinutes}} minutes. If you don&#39;t see the email, check your spam folder.</p>
  </main>
</body>
</html>
`;

/**
 * App Review demo bypass (env-gated; see `reviewDemoConfig` in
 * `oauth.ts`): rendered instead of EMAIL_SENT_TEMPLATE when the
 * submitted address IS the configured demo account. The reviewer types
 * the fixed code from the App Review notes; no email is sent. The form
 * POSTs to /oauth/authorize/email/code with the same hidden
 * return_to + email and a fresh CSRF token.
 */
export const REVIEW_CODE_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Enter access code</title>
${SHARED_STYLE}
</head>
<body>
  <main>
    <h1>Enter access code</h1>
    <p>This account uses a pre-shared access code instead of an emailed link.</p>
    <form method="post" action="/oauth/authorize/email/code">
      <input type="hidden" name="_csrf" value="{{csrfToken}}">
      <input type="hidden" name="return_to" value="{{returnTo}}">
      <input type="hidden" name="email" value="{{email}}">
      <label for="code">Access code</label>
      <input type="text" id="code" name="code" required autofocus
             autocomplete="one-time-code" inputmode="numeric" maxlength="64">
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>
`;
