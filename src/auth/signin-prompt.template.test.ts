/**
 * Spec 029-oauth-signin-prompt T002 + T007 — unit tests for the
 * sign-in prompt template module.
 *
 * Targets `renderSigninPrompt` in `signin-prompt.template.ts`. Pure
 * function over its params — no Express, no Prisma, no env-var
 * dependencies — so the unit suite is small, fast, and deterministic.
 *
 * Tests cover:
 *   - HTML-escape on every interpolated substitution (US1).
 *   - `returnTo` URL-encoded into the sign-in CTA and round-trippable (US1).
 *   - `scope` rendering — caller-supplied value appears verbatim (US1).
 *   - Snapshot stability of the rendered page (US1).
 *   - `clientName` non-empty → rendered as the page identity (US2).
 *   - `clientName` empty → fallback to "An application at <redirect_uri host>" (US2 / FR-002).
 *   - `redirect_uri` host extraction handles ports and paths correctly (US2).
 */

import { describe, it, expect } from 'vitest';
import { renderSigninPrompt } from './signin-prompt.template.js';

const DEFAULT_PARAMS = {
  clientName: 'Test MCP Client',
  redirectUri: 'https://client.example.com/callback',
  scope: 'mcp',
  resource: 'https://hadron.example/mcp',
  returnTo: '/oauth/authorize?client_id=dcr_abc&state=xyz',
};

describe('renderSigninPrompt — happy path (US1)', () => {
  it('produces a complete HTML document', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('renders the page title and primary heading', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    expect(html).toContain('<title>Sign in to Hadron</title>');
    expect(html).toContain('<h1>Sign in to Hadron</h1>');
  });

  it('renders the registered clientName as the page identity', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    expect(html).toContain('Test MCP Client is asking Hadron for access on your behalf.');
  });

  it('renders the requested scope verbatim', () => {
    const html = renderSigninPrompt({ ...DEFAULT_PARAMS, scope: 'mcp' });
    expect(html).toContain('Requested scope: <code>mcp</code>');
  });

  it('renders the requested resource verbatim', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    expect(html).toContain('Resource: <code>https://hadron.example/mcp</code>');
  });

  it('embeds the sign-in CTA pointing at /auth/github with URL-encoded return_to', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    const expectedHref = `/auth/github?return_to=${encodeURIComponent(DEFAULT_PARAMS.returnTo)}`;
    expect(html).toContain(`href="${expectedHref}"`);
  });

  it('embedded return_to round-trips losslessly via decodeURIComponent', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    const match = html.match(/href="\/auth\/github\?return_to=([^"]+)"/);
    expect(match, 'sign-in CTA href must be present').not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe(DEFAULT_PARAMS.returnTo);
  });

  it('does NOT set any cookies (pre-sign-in page, contract negative-space)', () => {
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    // No header machinery in the renderer itself, but assert the
    // template doesn't contain a meta http-equiv set-cookie or similar
    // (defense-in-depth — would catch an accidental copy-paste).
    expect(html.toLowerCase()).not.toContain('set-cookie');
  });
});

describe('renderSigninPrompt — HTML-escape (US1)', () => {
  it('escapes < and > in clientName (XSS guard)', () => {
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      clientName: '<script>alert(1)</script>',
    });
    // The opening `<script>` must be escaped; the literal tag must NOT
    // appear in the body. The escaped form `&lt;script&gt;` MUST appear.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes in scope (attribute-context guard)', () => {
    const html = renderSigninPrompt({ ...DEFAULT_PARAMS, scope: 'mcp" onerror="alert(1)' });
    // Double quote becomes &quot;
    expect(html).toContain('mcp&quot; onerror=&quot;alert(1)');
    // And the raw onerror= literal must NOT appear unescaped near a
    // tag boundary that could be interpreted as an event handler.
    expect(html).not.toContain('mcp" onerror="alert(1)');
  });

  it('escapes ampersand in resource', () => {
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      resource: 'https://hadron.example/mcp?a=1&b=2',
    });
    expect(html).toContain('https://hadron.example/mcp?a=1&amp;b=2');
  });

  it('escapes apostrophe in clientName', () => {
    const html = renderSigninPrompt({ ...DEFAULT_PARAMS, clientName: "O'Reilly's Connector" });
    expect(html).toContain('O&#39;Reilly&#39;s Connector');
  });

  it('escapes < and > injected via returnTo before URL-encoding (defense-in-depth)', () => {
    // `encodeURIComponent` already escapes `<` and `>` to %3C / %3E,
    // so they don't reach the HTML-escape pass as raw `<` / `>`. But
    // the test pins the chain — even if encodeURIComponent were
    // somehow bypassed, the HTML-escape pass would still neutralize.
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      returnTo: '/oauth/authorize?state=<script>',
    });
    expect(html).not.toContain('<script>');
    // The literal `<` from returnTo is now %3C (URL-encoded); HTML
    // escaping is a no-op on `%`. Either form is safe in an href
    // attribute value.
    expect(html).toContain('href="/auth/github?return_to=');
  });
});

describe('renderSigninPrompt — clientName fallback (US2 / FR-002)', () => {
  it('falls back to "An application at <host>" when clientName is empty', () => {
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      clientName: '',
      redirectUri: 'https://app.example.com/callback',
    });
    expect(html).toContain(
      'An application at app.example.com is asking Hadron for access on your behalf.',
    );
  });

  it('does NOT render the raw client_id (no GUID leak in fallback)', () => {
    // The renderer doesn't receive client_id, but pin the negative
    // contract: the body must never contain a `dcr_` GUID even when
    // clientName is empty.
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      clientName: '',
      redirectUri: 'https://app.example.com/callback',
    });
    expect(html).not.toMatch(/dcr_[a-f0-9]+/);
  });

  it('extracts host correctly when redirect_uri carries a non-default port', () => {
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      clientName: '',
      redirectUri: 'https://app.example.com:8443/callback',
    });
    expect(html).toContain('An application at app.example.com:8443 is asking Hadron');
  });

  it('extracts host correctly when redirect_uri is http://localhost:N (dev)', () => {
    const html = renderSigninPrompt({
      ...DEFAULT_PARAMS,
      clientName: '',
      redirectUri: 'http://localhost:4000/cb',
    });
    expect(html).toContain('An application at localhost:4000');
  });

  it('uses the registered clientName verbatim when non-empty (US2 normal path)', () => {
    const html = renderSigninPrompt({ ...DEFAULT_PARAMS, clientName: 'Claude Desktop' });
    expect(html).toContain('Claude Desktop is asking Hadron for access on your behalf.');
    // And the fallback phrasing must NOT appear when a name is registered.
    expect(html).not.toContain('An application at');
  });
});

describe('renderSigninPrompt — scope defaulting (US1)', () => {
  it('renders whatever scope the caller supplied (caller defaults to "mcp")', () => {
    // The renderer itself does not default — the caller in oauth.ts
    // applies `'mcp'` when q.scope is absent. The template just
    // displays what it's given. Pin the contract by passing a
    // non-default scope and confirming it appears verbatim.
    const html = renderSigninPrompt({ ...DEFAULT_PARAMS, scope: 'some-custom-scope' });
    expect(html).toContain('<code>some-custom-scope</code>');
  });

  it('handles empty resource by rendering an empty <code></code>', () => {
    // Spec 029 contracts/signin-prompt-page.md permits any
    // deterministic rendering for an empty resource — empty code
    // tags is the simplest and matches consent.template.ts.
    const html = renderSigninPrompt({ ...DEFAULT_PARAMS, resource: '' });
    expect(html).toContain('Resource: <code></code>');
  });
});

describe('renderSigninPrompt — snapshot stability', () => {
  it('produces a stable HTML body for canonical inputs', () => {
    // Catches accidental copy churn. If the prompt page's wording
    // changes intentionally, update this snapshot in the same PR.
    const html = renderSigninPrompt(DEFAULT_PARAMS);
    expect(html).toMatchSnapshot();
  });
});
