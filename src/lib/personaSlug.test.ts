/**
 * #974 — the persona slug compound + the dot reservation (cor:agt:020:06,
 * cor:urn:010:03).
 */
import { describe, it, expect } from 'vitest';
import { GraphQLError } from 'graphql';
import {
  assertDotFreeSlug,
  slugFromEntityUrn,
  personaNameSlug,
  derivePersonaAgentSlug,
} from './personaSlug.js';

describe('assertDotFreeSlug', () => {
  it('passes a dot-free slug', () => {
    expect(() => assertDotFreeSlug('eng-team', 'App')).not.toThrow();
  });

  it('refuses a dotted slug with BAD_USER_INPUT', () => {
    try {
      assertDotFreeSlug('eng-team.iris', 'agent');
      expect.fail('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT');
      expect((e as GraphQLError).extensions?.offendingValue).toBe('eng-team.iris');
    }
  });
});

describe('slugFromEntityUrn', () => {
  it('splits on the FIRST colon — a dotted org root stays in the owner atom', () => {
    expect(slugFromEntityUrn('micromentor.org:eng-team')).toBe('eng-team');
    expect(slugFromEntityUrn('holger:eng-team')).toBe('eng-team');
  });
});

describe('personaNameSlug', () => {
  it('never emits a dot — dots fold to a hyphen before slugification', () => {
    expect(personaNameSlug('R2.D2')).toBe('r2-d2');
    expect(personaNameSlug('Iris')).toBe('iris');
    expect(personaNameSlug('Mary Jane')).toBe('mary-jane');
  });
});

describe('derivePersonaAgentSlug', () => {
  it('composes <team-app-slug>.<persona-name-slug> with exactly one dot', () => {
    const slug = derivePersonaAgentSlug('micromentor.org:eng-team', 'Iris');
    expect(slug).toBe('eng-team.iris');
    expect(slug.split('.')).toHaveLength(2);
  });

  it('is injective across teams — the collision-freedom argument', () => {
    expect(derivePersonaAgentSlug('acme.com:eng-team', 'Iris')).toBe('eng-team.iris');
    expect(derivePersonaAgentSlug('acme.com:data-team', 'Iris')).toBe('data-team.iris');
  });

  it('refuses rather than truncating past the 64-char atom limit', () => {
    const longName = 'a'.repeat(60);
    expect(() => derivePersonaAgentSlug('acme.com:eng-team', longName)).toThrow(/longer than/);
  });

  it('refuses a dotted team App slug (pre-reservation data)', () => {
    expect(() => derivePersonaAgentSlug('acme.com:eng.team', 'Iris')).toThrow(/contains a "\."/);
  });
});
