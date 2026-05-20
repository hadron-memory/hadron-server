/**
 * Spec 025-oauth-for-mcp T037 — consent screen template.
 *
 * Extracted from PR 137's inline `res.send(\`<!doctype html>…\`)` so
 * the markup is reviewable separately from the handler logic. Lives
 * in a TypeScript module rather than a `.html` asset because the
 * project's build step (`tsc` to `dist/`) doesn't copy non-TS assets.
 * Keeping the markup in a `.ts` export sidesteps an asset-pipeline
 * change for what's a single-file deliverable.
 *
 * The placeholders (`{{name}}`) are substituted by `renderConsent`
 * in `oauth.ts`. ALL values are HTML-escaped before substitution —
 * the template has no `{{{triple}}}`-style raw insertion points.
 *
 * Form action and middleware ordering must stay in sync with the
 * router in `oauth.ts`:
 *   - POST `/oauth/authorize` ← `express.urlencoded` ← `csrf-csrf`
 *     ← `handleAuthorizePost`.
 *   - The hidden `_csrf` input MUST match the cookie set by the
 *     `generateCsrfToken` call in the GET handler.
 */
export const CONSENT_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Authorize {{clientName}}</title>
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
      button[name="decision"][value="deny"] { background: transparent; color: #e6e6e6; border: 1px solid #555; }
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
    form { display: flex; gap: 0.5rem; margin-top: 1.5rem; }
    button[name="decision"] {
      flex: 1; padding: 0.6rem 1rem;
      font: inherit; font-weight: 500;
      border-radius: 6px; border: 0;
      cursor: pointer;
    }
    button[name="decision"][value="approve"] { background: #0a66ff; color: #fff; }
    button[name="decision"][value="approve"]:hover { background: #0855d0; }
    button[name="decision"][value="deny"]      { background: transparent; color: #1c1c1c; border: 1px solid #ccc; }
    button[name="decision"][value="deny"]:hover { background: #f0f0f0; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize {{clientName}}</h1>
    <p>The application <strong>{{clientName}}</strong> is requesting access to your Hadron account.</p>
    <ul>
      <li>Scope: <code>{{scope}}</code></li>
      <li>Resource: <code>{{resource}}</code></li>
    </ul>
    <p>If you approve, the application will be issued an authorization code that it can exchange for an access token to act on your behalf at the resource above.</p>
    <form method="post" action="/oauth/authorize" autocomplete="off">
      <input type="hidden" name="_csrf"                 value="{{csrfToken}}">
      <input type="hidden" name="client_id"             value="{{clientId}}">
      <input type="hidden" name="redirect_uri"          value="{{redirectUri}}">
      <input type="hidden" name="code_challenge"        value="{{codeChallenge}}">
      <input type="hidden" name="code_challenge_method" value="{{codeChallengeMethod}}">
      <input type="hidden" name="resource"              value="{{resource}}">
      <input type="hidden" name="scope"                 value="{{scope}}">
      <input type="hidden" name="state"                 value="{{state}}">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="approve">Approve</button>
    </form>
  </main>
</body>
</html>
`;
