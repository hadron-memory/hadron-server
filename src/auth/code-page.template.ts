/**
 * #5125 — the page that shows the authorization code after consent, for a login finished on another device
 * (hrn:node:hadronmemory.com:specs:cor:aut:030:01). Rendered only by the consent POST, and only when the authorize
 * request asked for it. Same card and header as the consent page. The one script copies the field; without it the
 * code stays selectable by hand.
 */
import { HADRON_HEADER, HADRON_HEADER_STYLE } from './hadron-header.template.js';

export const CODE_PAGE_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Your sign-in code</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa; --card-bg: #fff; --card-border: #e5e5e5; --text: #1c1c1c;
      --field-bg: #f0f0f0; --field-border: #767676;
      --warn-bg: #fff4e5; --warn-border: #e0a252; --warn-text: #4a3208;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1c1c1c; --card-bg: #262626; --card-border: #333; --text: #e6e6e6;
        --field-bg: #333; --field-border: #8c8c8c;
        --warn-bg: #3a2c14; --warn-border: #8a6524; --warn-text: #f2ddba;
      }
    }
    body {
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; padding: 2rem 1rem;
      background: var(--bg); color: var(--text);
      display: flex; justify-content: center;
    }
    main {
      box-sizing: border-box;
      max-width: calc(480px + 4rem + 2px); width: 100%;
      background: var(--card-bg); color: var(--text);
      border: 1px solid var(--card-border); border-radius: 8px;
      padding: 1.5rem 2rem;
    }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    h1, p { overflow-wrap: anywhere; }
    label { display: block; font-weight: 500; margin: 1rem 0 0.35rem; }
    #code {
      box-sizing: border-box; width: 100%; min-height: 2.75rem; padding: 0.5rem 0.75rem;
      font: 0.9rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: var(--field-bg); color: var(--text);
      border: 1px solid var(--field-border); border-radius: 6px;
    }
    #copy {
      display: block; width: 100%; min-height: 2.75rem; margin: 0.75rem 0 0; padding: 0.6rem 1rem;
      font: inherit; font-weight: 500; border: 0; border-radius: 6px;
      background: #0a66ff; color: #fff; cursor: pointer;
    }
    #copy:hover { background: #0855d0; }
    :focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
    #status { min-height: 1.45em; margin: 0.5rem 0 0; }
    .warn {
      background: var(--warn-bg); color: var(--warn-text);
      border: 1px solid var(--warn-border); border-radius: 6px;
      padding: 0.75rem 0.9rem; margin: 1rem 0 0;
    }
  </style>
${HADRON_HEADER_STYLE}
</head>
<body>
  <main>
    ${HADRON_HEADER}
    <h1>Copy your sign-in code</h1>
    <p>Paste this code where <strong>{{clientName}}</strong> is waiting for it. It works once and expires in 10 minutes.</p>
    <label for="code">Sign-in code</label>
    <input id="code" type="text" readonly autocomplete="off" spellcheck="false" value="{{code}}">
    <button id="copy" type="button">Copy code</button>
    <p id="status" role="status" aria-live="polite"></p>
    <p class="warn"><strong>Do not share this code.</strong> Use it only if you started this sign-in yourself. No one from Hadron will ask you for it.</p>
  </main>
  <script nonce="{{nonce}}">
    (function () {
      var field = document.getElementById('code');
      var status = document.getElementById('status');
      field.addEventListener('focus', function () { field.select(); });
      document.getElementById('copy').addEventListener('click', function () {
        function byHand() { field.focus(); field.select(); status.textContent = 'Press Ctrl+C or Cmd+C to copy the code.'; }
        if (!navigator.clipboard) { byHand(); return; }
        navigator.clipboard.writeText(field.value).then(function () { status.textContent = 'Code copied.'; }, byHand);
      });
    })();
  </script>
</body>
</html>
`;
