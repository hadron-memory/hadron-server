/**
 * #168 — server-hosted sign-in prompt for an MCP connector flow.
 *
 * Rendered by `GET /oauth/authorize` when the caller has no session, did not
 * choose a `login_provider`, and `resource` is exactly this server's `/mcp`.
 * The inline branch in `oauth.ts` requires `q.login_provider === undefined`
 * and q.resource === `${origin}/mcp` with a trusted, non-null origin.
 * An omitted provider defaults to `github`. The page explains why a sign-in
 * is needed and offers a link that starts that GitHub flow and returns to the
 * same authorize URL, plus a secondary link to the same authorize URL with
 * `login_provider=email` (the existing email-entry page). A plain link, not a form: the target is a GET that
 * changes no state, so there is nothing for CSRF to protect.
 *
 * All placeholders are HTML-escaped by `renderTemplate`; `clientName` is
 * attacker-controlled (DCR). `signInUrl` is built by the caller from the
 * allow-listed provider and `encodeURIComponent(req.originalUrl)` only; `emailUrl` is the fixed local
 * `/oauth/authorize` path plus the original query.
 */

import { SHARED_STYLE } from './email-entry.template.js';

export const SIGNIN_PROMPT_TEMPLATE = `<!doctype html>
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
    <p><strong>{{clientName}}</strong> is asking to connect to your Hadron account.</p>
    <p>You need to sign in to Hadron first. After you sign in, you&#39;ll come back to review and approve the connection.</p>
    <a class="button" href="{{signInUrl}}">Continue with GitHub</a>
    <p class="muted">No GitHub account? <a href="{{emailUrl}}">Use email instead</a></p>
    <p class="muted">If you didn&#39;t expect this, close this tab.</p>
  </main>
</body>
</html>
`;
