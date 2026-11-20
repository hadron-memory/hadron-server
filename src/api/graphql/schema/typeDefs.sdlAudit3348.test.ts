import { describe, expect, it } from 'vitest';
import { parse } from 'graphql';
import type { ObjectTypeDefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';

function description(type: string, field: string): string {
  // Object types only (Definition + Extension): this guard reads fields of
  // Query/Mutation, and a same-named input must not satisfy the lookup.
  const definition = parse(typeDefs).definitions.find(
    (n): n is ObjectTypeDefinitionNode =>
      (n.kind === 'ObjectTypeDefinition' || n.kind === 'ObjectTypeExtension') && n.name.value === type,
  );
  if (!definition) throw new Error(`Missing object type ${type}`);
  // A missing field must refuse rather than resolve to '': with `?? ''` a
  // renamed field would pass every `not.toContain` assertion vacuously (#4479 F3).
  const target = definition.fields?.find(n => n.name.value === field);
  if (!target) throw new Error(`Missing field ${type}.${field}`);
  // Normalize whitespace: block descriptions keep their source wrapping, and the
  // guard pins the wording, not the line breaks.
  return (target.description?.value ?? '').replace(/\s+/g, ' ');
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
    // No independent refusal enumeration that could drift from the corrected appKeys
    // text — deliberately loose on purpose (any refusal roster word trips it).
    expect(
      text,
      'appKeysPage must carry no refusal roster of its own; finding "impersonat" here is an independent enumeration drifting from the corrected appKeys wording',
    ).not.toContain('impersonat');
  });
  it('the helper refuses a missing field or a non-object definition instead of matching nothing', () => {
    expect(() => description('Query', 'noSuchField')).toThrow('Missing field Query.noSuchField');
    expect(() => description('NotAnObjectType', 'appKeys')).toThrow('Missing object type NotAnObjectType');
    // A same-named input has fields too — the lookup is about Query/Mutation.
    expect(() => description('ActInstructionInput', 'ref')).toThrow('Missing object type ActInstructionInput');
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
