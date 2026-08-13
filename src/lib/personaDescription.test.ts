/**
 * #950 — the persona description string. One definition shared by the mint
 * path and the backfill sweep; the role slug is humanized for the synthesized
 * sentence only.
 */
import { describe, it, expect } from 'vitest';
import {
  humanizeRole,
  applyPersonaTemplate,
  composePersonaDescription,
} from './personaDescription.js';

describe('humanizeRole', () => {
  it('turns a loc-atom role slug into prose', () => {
    expect(humanizeRole('backend-engineer')).toBe('backend engineer');
    expect(humanizeRole('coordinator')).toBe('coordinator');
    expect(humanizeRole('site_reliability-engineer')).toBe('site reliability engineer');
    expect(humanizeRole('qa--lead')).toBe('qa lead');
    expect(humanizeRole('-qa-')).toBe('qa');
  });
});

describe('composePersonaDescription', () => {
  it('synthesizes the spaced wording #950 specifies', () => {
    expect(composePersonaDescription(null, 'Iris', 'backend-engineer')).toBe(
      'AI coding agent using backend engineer role',
    );
    expect(composePersonaDescription({}, 'Ada', 'coordinator')).toBe(
      'AI coding agent using coordinator role',
    );
  });

  it('a data.personaDescription template wins, and keeps the RAW role', () => {
    // The template is author-controlled: {{role}} renders the role exactly as
    // the prompt template does, so an existing template is unaffected by the
    // humanizing above.
    expect(
      composePersonaDescription(
        { personaDescription: '{{name}} — {{role}} on the team' },
        'Iris',
        'backend-engineer',
      ),
    ).toBe('Iris — backend-engineer on the team');
  });

  it('falls back when the template is blank or not a string', () => {
    for (const personaDescription of ['', '   ', 42, null]) {
      expect(composePersonaDescription({ personaDescription }, 'Iris', 'backend-engineer')).toBe(
        'AI coding agent using backend engineer role',
      );
    }
  });
});

describe('applyPersonaTemplate', () => {
  it('inserts replacement-pattern characters literally', () => {
    // split/join rather than replaceAll: `$&` in a name must not be treated as
    // a replacement pattern.
    expect(applyPersonaTemplate('You are {{name}}.', "$& O'$'Brien", 'x')).toBe(
      "You are $& O'$'Brien.",
    );
  });
});
