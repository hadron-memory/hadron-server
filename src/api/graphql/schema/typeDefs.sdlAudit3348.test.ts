import { describe, expect, it } from 'vitest';
import { parse } from 'graphql';
import { typeDefs } from './typeDefs.js';

function description(type: string, field: string): string {
  const definition = parse(typeDefs).definitions.find(n => 'name' in n && n.name?.value === type);
  if (!definition || !('fields' in definition)) throw new Error(`Missing ${type}`);
  // Normalize whitespace: block descriptions keep their source wrapping, and the
  // guard pins the wording, not the line breaks.
  return (definition.fields!.find(n => n.name.value === field)?.description?.value ?? '').replace(/\s+/g, ' ');
}

/** The #3340 ruling, pinned behavior-first in resolvers.instructedCredentialActs3311.test.ts. */
const RUN_ADMITTED =
  'a plain user-backed run is admitted, as before, when the user it carries manages the App (#3340)';
const RUN_REFUSED = 'a run that carries a worker session';

describe('#3348 SDL wording: a user-backed run is admitted at the revoke doors and the key list', () => {
  it('appKeys names exactly who is refused instead of lumping in the run', () => {
    const text = description('Query', 'appKeys');
    expect(text).toContain(RUN_ADMITTED);
    expect(text).toContain(RUN_REFUSED);
    expect(text).not.toContain('a run or an impersonated request');
  });
  it('appKeysPage inherits the corrected gate and refusals from appKeys', () => {
    const text = description('Query', 'appKeysPage');
    expect(text).toContain('the same manager-only gate and refusals');
    // No independent refusal enumeration that could drift from the corrected appKeys text.
    expect(text).not.toContain('impersonat');
  });
  it('revokeAppKey names exactly who is refused instead of lumping in the run', () => {
    const text = description('Mutation', 'revokeAppKey');
    expect(text).toContain(RUN_ADMITTED);
    expect(text).toContain(RUN_REFUSED);
    expect(text).not.toContain('a run or an impersonated request');
  });
  it('revokeAppKeyScope states the run case instead of omitting it', () => {
    const text = description('Mutation', 'revokeAppKeyScope');
    expect(text).toContain(RUN_ADMITTED);
    expect(text).toContain(RUN_REFUSED);
  });
  it('revokeAppGrant states the run case instead of omitting it', () => {
    const text = description('Mutation', 'revokeAppGrant');
    expect(text).toContain(RUN_ADMITTED);
    expect(text).toContain(RUN_REFUSED);
  });
});
