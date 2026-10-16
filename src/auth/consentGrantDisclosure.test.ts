/**
 * #559 / #1261 — consent states the effective grant. The copy is rendered
 * from the validated OAuth scope set so an MCP-only grant is described as
 * limited while the broad account grant keeps the explicit whole-account and
 * non-cascading-revocation warning.
 */

import { describe, it, expect } from 'vitest';
import { CONSENT_TEMPLATE } from './consent.template.js';
import { renderConsent } from './oauth.js';

const consentBase = {
  clientName: 'Test Client',
  resource: 'https://hadron.example/mcp',
  clientId: 'client-1',
  redirectUri: 'https://client.example/callback',
  codeChallenge: 'a'.repeat(43),
  codeChallengeMethod: 'S256',
  state: 'state',
  csrfToken: 'csrf',
  grantProof: 'proof',
};

describe('#1261 — consent copy matches the effective OAuth grant', () => {
  it('describes mcp as limited and explicitly rules out account interfaces + key minting', () => {
    const html = renderConsent({ ...consentBase, oauthScopes: ['mcp'] });
    expect(html).toContain('limited to Hadron&#39;s MCP interface');
    expect(html).toContain('refuse this token at GraphQL and other account interfaces');
    expect(html).toContain('It cannot create further API keys');
    expect(html).not.toContain('same account access you do');
  });

  it('warns that account grants whole-account access, key minting, and non-cascading revocation', () => {
    const html = renderConsent({ ...consentBase, oauthScopes: ['account'] });
    expect(html).toContain('same account access you do');
    expect(html).toContain('create further API keys of its own');
    expect(html).toContain('Revoking this token also revokes keys created with it and their descendants');
    expect(html).not.toContain('does not automatically revoke');
    expect(html).toContain('Historical keys with no recorded parent are not included');
  });

  it('treats a combined grant as broad account authority', () => {
    const html = renderConsent({ ...consentBase, oauthScopes: ['mcp', 'account'] });
    expect(html).toContain('same account access you do');
    expect(html).toContain('value="mcp account"');
  });
});

describe('#559 — the disclosure survives the template contract', () => {
  it('keeps the placeholders the renderer substitutes', () => {
    // The new copy interpolates {{clientName}}. If a placeholder is renamed or
    // dropped the screen renders a literal brace to the user, which is both
    // ugly and a tell that the warning was edited without its renderer.
    for (const token of [
      '{{clientName}}',
      '{{scope}}',
      '{{resource}}',
      '{{csrfToken}}',
      '{{grantProof}}',
      '{{grantHeading}}',
      '{{grantBody}}',
      '{{grantSub}}',
    ]) {
      expect(CONSENT_TEMPLATE, `${token} must still be present`).toContain(token);
    }
  });

  it('defines every warning colour as a light/dark PAIR', () => {
    // Issue #318's convention, and the warning block sets a background — so
    // without a dark value a forced-dark pass recolours the inherited text
    // against an untouched light panel, which is how this notice would become
    // unreadable precisely where it matters.
    const dark = CONSENT_TEMPLATE.slice(CONSENT_TEMPLATE.indexOf('prefers-color-scheme: dark'));
    for (const v of ['--warn-bg', '--warn-border', '--warn-text']) {
      expect(CONSENT_TEMPLATE, `${v} must be defined`).toContain(`${v}:`);
      expect(dark, `${v} must have a dark value`).toContain(`${v}:`);
    }
  });

  it('pins the warning block\'s own text colour, not just its background', () => {
    // The #318 defect verbatim: a panel that sets a background and inherits
    // its colour goes near-invisible under force-dark.
    const warnRule = CONSENT_TEMPLATE.slice(
      CONSENT_TEMPLATE.indexOf('.warn {'),
      CONSENT_TEMPLATE.indexOf('.warn-sub'),
    );
    expect(warnRule).toContain('background: var(--warn-bg)');
    expect(warnRule).toContain('color: var(--warn-text)');
  });
});
