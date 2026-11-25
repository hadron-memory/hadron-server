/**
 * #5001 (cor:acl:140:07, :09): contract pins that need no database.
 *  P14: no action declares confirm-at-use today (ruling R3: vacuous), so a selection has nothing to exclude. The pin fails the day
 *       one does, because the exclusion would then be unbuilt.
 *  P20: the SDL text of the selection mutation names the cap and every refusal it can raise, and the selection type exposes
 *       `lastRefusedAt`.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_ACTIONS } from '../../../lib/grants/actions.js';
import { GRANT_SELECTION_CAP } from '../../../lib/signing/grantSelectionPayload.js';
import { typeDefs } from './typeDefs.js';

const sdl = typeof typeDefs === 'string' ? typeDefs : JSON.stringify(typeDefs);
const docOf = (decl: string): string => {
  const i = sdl.indexOf(decl);
  expect(i, `${decl} is declared`).toBeGreaterThan(-1);
  return sdl.slice(Math.max(0, i - 4000), i);
};

describe('P14: confirm-at-use is vacuous until an action declares it', () => {
  it('no platform action, parameter or definition key mentions confirmation', () => {
    for (const a of PLATFORM_ACTIONS) {
      expect(Object.keys(a).filter((k) => /confirm/i.test(k)), `${a.name} keys`).toEqual([]);
      expect(a.parameters.filter((p) => /confirm/i.test(p.name)), `${a.name} parameters`).toEqual([]);
    }
  });
});

describe('P20: the selection SDL documents the cap and every refusal', () => {
  it('requestGrantSelectionSignature names the cap and each refusal', () => {
    const doc = docOf('requestGrantSelectionSignature(grantRefs: [ID!]!)').split('"""').slice(-2, -1)[0] ?? '';
    expect(doc).toContain(`at most ${GRANT_SELECTION_CAP}`);
    for (const code of ['FORBIDDEN', 'SELECTION_EMPTY', 'SELECTION_TOO_LARGE', 'SELECTION_DUPLICATE_GRANT', 'GRANT_NOT_FOUND', 'SELECTION_MIXED_APPS', 'GRANT_NOT_PENDING', 'GRANT_EXPIRED', 'GRANT_TERMS_UNREPRESENTABLE']) {
      expect(doc, code).toContain(code);
    }
    expect(doc).toContain('GraphQL only');
  });

  it('withdrawGrantSigningSelection names its refusals; the selection type exposes lastRefusedAt', () => {
    const w = docOf('withdrawGrantSigningSelection(id: ID!)');
    for (const code of ['FORBIDDEN', 'SIGNING_REQUEST_NOT_FOUND', 'SIGNING_REQUEST_NOT_REQUESTER', 'SIGNING_REQUEST_ENDED']) expect(w, code).toContain(code);
    const t = sdl.slice(sdl.indexOf('type GrantSigningSelection {'));
    expect(t.slice(0, t.indexOf('\n  }'))).toContain('lastRefusedAt: DateTime');
  });
});
