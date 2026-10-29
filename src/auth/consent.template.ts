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
    /* Colors are defined as matched light/dark PAIRS via custom properties so a
       background and its foreground can never resolve to different schemes.
       Issue #318: the card (main) used to set only its background and INHERIT
       its text color from body. A forced/auto dark mode (browser force-dark, or
       a Dark Reader-style extension) recolored the inherited body text to the
       light value while leaving the explicitly-white card untouched, producing
       near-invisible light-gray text on a white card. The card now pins its own
       color to the same pair as its background, which closes that gap. Stock
       browsers render the same light/dark output as before. */
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --card-bg: #fff;
      --card-border: #e5e5e5;
      --text: #1c1c1c;
      --code-bg: #f0f0f0;
      --deny-border: #ccc;
      --deny-hover: #f0f0f0;
      /* #559 — the honest-grant notice. A matched PAIR like every other colour
         here (#318): the block sets a background, so it must pin its own text
         colour or a forced-dark pass recolours the inherited text against an
         untouched light panel. */
      --warn-bg: #fff4e5;
      --warn-border: #e0a252;
      --warn-text: #4a3208;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1c1c;
        --card-bg: #262626;
        --card-border: #333;
        --text: #e6e6e6;
        --code-bg: #333;
        --deny-border: #555;
        --deny-hover: #333;
        --warn-bg: #3a2c14;
        --warn-border: #8a6524;
        --warn-text: #f2ddba;
      }
    }
    body {
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; padding: 2rem 1rem;
      background: var(--bg); color: var(--text);
      display: flex; justify-content: center;
    }

    /* #559 — states what approval actually grants. Styled to be READ rather
       than skimmed past: a consent screen that understates the grant is worse
       than one with no detail at all, because it earns trust it has not
       verified. */
    .warn {
      background: var(--warn-bg);
      color: var(--warn-text);
      border: 1px solid var(--warn-border);
      border-radius: 6px;
      padding: 0.75rem 0.9rem;
      margin: 1rem 0 0.5rem;
    }
    .warn-sub {
      color: var(--text);
      font-size: 0.9em;
      margin: 0 0 1rem;
    }
    main {
      max-width: 480px; width: 100%;
      background: var(--card-bg); color: var(--text);
      border: 1px solid var(--card-border); border-radius: 8px;
      padding: 1.5rem 2rem;
    }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    ul { padding-left: 1.25rem; margin: 0.5rem 0 1.25rem; }
    li { margin: 0.25rem 0; }
    code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
    form { display: flex; gap: 0.5rem; margin-top: 1.5rem; }
    button[name="decision"] {
      flex: 1; padding: 0.6rem 1rem;
      font: inherit; font-weight: 500;
      border-radius: 6px; border: 0;
      cursor: pointer;
    }
    button[name="decision"][value="approve"] { background: #0a66ff; color: #fff; }
    button[name="decision"][value="approve"]:hover { background: #0855d0; }
    button[name="decision"][value="deny"]      { background: transparent; color: var(--text); border: 1px solid var(--deny-border); }
    button[name="decision"][value="deny"]:hover { background: var(--deny-hover); }
  </style>
</head>
<body>
  <main>
    <h1>Authorize {{clientName}}</h1>
    <p>The application <strong>{{clientName}}</strong> is requesting access to your Hadron account.</p>
    <p>Returns to: <code>{{redirectAnchor}}</code></p>
    <ul>
      <li>Scope: <code>{{scope}}</code></li>
      <li>Resource: <code>{{resource}}</code></li>
    </ul>
    <p>If you approve, the application will be issued an authorization code that it can exchange for an access token to act on your behalf.</p>
    <p class="warn"><strong>{{grantHeading}}</strong> {{grantBody}}</p>
    <p class="warn-sub">{{grantSub}}</p>
    <form method="post" action="/oauth/authorize" autocomplete="off">
      <input type="hidden" name="_csrf"                 value="{{csrfToken}}">
      <input type="hidden" name="grant_proof"           value="{{grantProof}}">
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
