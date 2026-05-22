/**
 * Spec 029-oauth-signin-prompt T004 — sign-in prompt page template.
 *
 * Rendered by `GET /oauth/authorize` when the request has no valid
 * `hadron_token` session cookie. Replaces the pre-029 silent
 * `302 → /auth/github?return_to=…` bounce with an actionable page that
 * names the requesting client and offers a single sign-in CTA. After
 * sign-in the user lands back at `/oauth/authorize` with the original
 * query string intact and the existing consent screen renders normally.
 *
 * Pattern mirrors `consent.template.ts` — a constant HTML string with
 * `{{placeholder}}` substitution slots, plus a `render*` function that
 * HTML-escapes every interpolated value. Unlike `consent.template.ts`,
 * the render function lives in this file (not in `oauth.ts`) so the
 * unit tests can import a small, dependency-free module — no Prisma
 * client, no Express types pulled in by `import './oauth.js'`.
 *
 * Form action / middleware ordering: not applicable — the CTA is a
 * plain `<a href="/auth/github?return_to=…">` (GET link). The
 * receiving `/auth/github` handler validates `return_to` via the
 * existing `isServerLocalPath` predicate established in spec 025; this
 * template just commits to passing it correctly URL-encoded.
 *
 * ALL placeholder values are HTML-escaped before substitution — the
 * template has no `{{{triple}}}`-style raw insertion points. Same
 * guarantee as `consent.template.ts`.
 */

export const SIGNIN_PROMPT_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in to Hadron</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; padding: 2rem 1rem; background: #fafafa; color: #1c1c1c;
      display: flex; justify-content: center;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1c1c1c; color: #e6e6e6; }
      main { background: #262626; border-color: #333; }
      code { background: #333; }
    }
    main {
      max-width: 480px; width: 100%;
      background: #fff; border: 1px solid #e5e5e5; border-radius: 8px;
      padding: 1.5rem 2rem;
    }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    ul { padding-left: 1.25rem; margin: 0.5rem 0 1.25rem; }
    li { margin: 0.25rem 0; }
    code { background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
    a.primary {
      display: inline-block;
      margin-top: 0.5rem;
      padding: 0.6rem 1rem;
      background: #0a66ff; color: #fff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 500;
    }
    a.primary:hover { background: #0855d0; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to Hadron</h1>
    <p>{{clientIdentity}} is asking Hadron for access on your behalf.</p>
    <ul>
      <li>Requested scope: <code>{{scope}}</code></li>
      <li>Resource: <code>{{resource}}</code></li>
    </ul>
    <p>To continue, sign in to Hadron. After you sign in, you will see a screen asking whether to approve this access.</p>
    <p><a class="primary" href="{{signinUrl}}">Sign in to Hadron</a></p>
  </main>
</body>
</html>
`;

/**
 * HTML-escape a value for safe insertion into the prompt template.
 * Every prompt-template substitution flows through this — there are
 * no raw-insertion points in `SIGNIN_PROMPT_TEMPLATE`. Local copy of
 * the helper in `oauth.ts` to keep this module's import graph minimal
 * (the unit tests import only from this file).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface SigninPromptParams {
  /** Registered `OAuthClient.clientName` — may be empty if DCR provided no name. */
  clientName: string;
  /** The registered `redirect_uri` (used to derive a fallback identifier when `clientName` is empty). */
  redirectUri: string;
  /** Raw `scope` query param (e.g., `'mcp'`); pre-defaulted by caller. */
  scope: string;
  /** Raw `resource` query param. May be empty. */
  resource: string;
  /** The original `/oauth/authorize` URL (path + query) to round-trip through GitHub sign-in. */
  returnTo: string;
}

/**
 * Render the prompt-page HTML. Computes the human-readable client
 * identity (registered `clientName` if available, else the
 * `redirect_uri` host as a safe fallback per spec 029 FR-002 / FR-008),
 * URL-encodes `returnTo` into the sign-in CTA, and HTML-escapes every
 * substitution value.
 *
 * Fallback identity uses `new URL(redirectUri).host` — `redirectUri`
 * is guaranteed to be a registered, validated URL by the caller
 * (`validateClientAndRedirectUri` in `oauth.ts`), so `new URL` won't
 * throw on a real production call. A unit test pins this.
 */
export function renderSigninPrompt(params: SigninPromptParams): string {
  const clientIdentity =
    params.clientName.length > 0
      ? params.clientName
      : `An application at ${new URL(params.redirectUri).host}`;

  const signinUrl = `/auth/github?return_to=${encodeURIComponent(params.returnTo)}`;

  const substitutions: Record<string, string> = {
    clientIdentity,
    scope: params.scope,
    resource: params.resource,
    signinUrl,
  };

  let html = SIGNIN_PROMPT_TEMPLATE;
  for (const [key, value] of Object.entries(substitutions)) {
    const placeholder = `{{${key}}}`;
    const safe = escapeHtml(value);
    html = html.split(placeholder).join(safe);
  }
  return html;
}
