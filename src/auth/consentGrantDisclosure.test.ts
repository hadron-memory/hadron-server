/**
 * #559 — the consent screen states what approval actually grants.
 *
 * `/oauth/authorize` advertises `scope: mcp` and a `resource` of
 * `<origin>/mcp`, and the screen said the token would "act on your behalf at
 * the resource above". A user reads that as scoped access to one endpoint.
 *
 * It is not. `/oauth/token` mints a plain `hdr_user_*` key through the same
 * `mintUserApiKey` as a portal PAT, and `resolveUserApiKey` resolves it to the
 * full user with no scope constraint. Approving grants the client everything
 * the user can do, through every interface — and the client can mint further
 * keys of its own, which revoking this one does not touch.
 *
 * ## Why this fixes the DISCLOSURE and not the grant
 *
 * #559 also asks for the token to be bound to the consented scope and refused
 * at `/graphql`. That half is NOT done here, deliberately, and it is not a
 * matter of effort:
 *
 *  - Credential parity is a SPECIFIED requirement, not an oversight. Spec 025
 *    FR-015 / US4 / SC-001 requires an OAuth-issued token and a portal-minted
 *    key to be indistinguishable at the credential layer, and
 *    `025-credential-parity.test.ts` exists to enforce exactly that.
 *  - `hadron auth login` (the CLI's browser strategy) obtains its token from
 *    `/oauth/token` and is a GraphQL client throughout. Refusing OAuth tokens
 *    at `/graphql` would break the CLI's primary login path.
 *
 * So "bind the token to the scope" is a product decision that changes a spec
 * and a shipped client, raised with the project lead rather than made in a
 * security pass. Until it is made, the honest thing is to stop the consent
 * screen implying a limit that does not exist — which is #559's own stated
 * minimum.
 *
 * These cases assert the DISCLOSURE, so it cannot quietly regress to the
 * reassuring version.
 */

import { describe, it, expect } from 'vitest';
import { CONSENT_TEMPLATE } from './consent.template.js';

describe('#559 — the consent screen does not imply a scope limit', () => {
  it('no longer promises the token acts only "at the resource above"', () => {
    // The exact phrasing that made a full-account grant read as a scoped one.
    expect(CONSENT_TEMPLATE).not.toContain('on your behalf at the resource above');
  });

  it('says the token has the same access as the user', () => {
    expect(CONSENT_TEMPLATE).toContain('This token has the same access you do');
  });

  it('says the scope and resource do NOT limit the token', () => {
    // The specific misreading being corrected: the screen shows a scope and a
    // resource, and a reader takes those for a boundary.
    expect(CONSENT_TEMPLATE).toMatch(/do\s*<strong>not<\/strong>\s*\n?\s*limit the token/);
  });

  it('does not promise that revoking this token ends the access', () => {
    // @codex P1 on PR #1252, and the irony is the point: the first version of
    // this warning — written to remove a false reassurance — contained one.
    //
    // An approved client can call `createUserApiKey` with this very token
    // (the resolver needs only `ctx.userId`, which an OAuth token supplies).
    // The derived key is recorded as `issuedVia: 'portal'` with NO parent
    // linkage, so revoking the OAuth key leaves it fully active and
    // indistinguishable from one the user made themselves. "Until you revoke
    // it" was false in exactly the hostile case the warning exists for.
    expect(CONSENT_TEMPLATE).not.toContain('until you revoke it');
    expect(CONSENT_TEMPLATE).not.toContain('revoke this access at any time');
  });

  it('warns that the token can mint further keys, and that revocation does not cascade', () => {
    expect(CONSENT_TEMPLATE).toContain('create further API keys of its own');
    expect(CONSENT_TEMPLATE).toMatch(/Revoking this token does\s*<strong>not<\/strong>/);
  });
});

describe('#559 — the disclosure survives the template contract', () => {
  it('keeps the placeholders the renderer substitutes', () => {
    // The new copy interpolates {{clientName}}. If a placeholder is renamed or
    // dropped the screen renders a literal brace to the user, which is both
    // ugly and a tell that the warning was edited without its renderer.
    for (const token of ['{{clientName}}', '{{scope}}', '{{resource}}', '{{csrfToken}}']) {
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
