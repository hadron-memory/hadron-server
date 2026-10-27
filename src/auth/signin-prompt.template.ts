/**
 * #168 — server-hosted sign-in prompt for an MCP connector flow.
 *
 * Rendered by `GET /oauth/authorize` when the caller has no session, did not
 * choose a `login_provider`, and `resource` is exactly this server's `/mcp`
 * (see `isMcpConnectorFlow` in `oauth.ts`). It explains why a sign-in is needed
 * and offers ONE link that starts the normal GitHub flow and returns to the
 * same authorize URL. A plain link, not a form: the target is a GET that
 * changes no state, so there is nothing for CSRF to protect.
 *
 * Both placeholders are HTML-escaped by `renderTemplate`; `clientName` is
 * attacker-controlled (DCR). `signInUrl` is built by the caller from the
 * allow-listed provider and `encodeURIComponent(req.originalUrl)` only.
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
    <p>You need to sign in to Hadron first. After you sign in, you&#39;ll come back here to review and approve the connection.</p>
    <a class="button" href="{{signInUrl}}">Sign in to Hadron</a>
  </main>
</body>
</html>
`;
