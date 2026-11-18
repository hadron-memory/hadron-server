/** #1772 step 3: the legacy `{{name}}` / `{{role}}` binding is gone (G3: no live served text holds one). */
import { describe, expect, it } from 'vitest';
import * as persona from './personaDescription.js';

const values = {
  'worker.name': 'Iris', 'worker.role': 'tester', 'agent.name': 'Agent',
  'worker.reportsTo.name': 'Bo', 'worker.signature': 'sig', 'worker.trailer': 'trl',
  'worker.url': 'https://p/x', 'session.llmModel': 'm-1',
};

describe('#1772 step 3: legacy tokens no longer bind', () => {
  it('{{name}} and {{role}} stay as written, like any token outside the closed set (control: already true with no legacy argument)', () => {
    expect(persona.applyPlatformVariables('{{name}}|{{role}}|{{worker.name}}|{{worker.role}}', values)).toBe('{{name}}|{{role}}|Iris|tester');
  });

  it('a third argument cannot revive them', () => {
    const apply = persona.applyPlatformVariables as (t: string, v: typeof values, legacy?: { name: string; role: string }) => string;
    expect(apply('{{name}} {{role}}', values, { name: 'Zed', role: 'x' })).toBe('{{name}} {{role}}');
  });

  it('the legacy value helper is gone', () => {
    expect(persona).not.toHaveProperty('legacyFromValues');
  });
});

describe('#1772 step 3 review P2: a record replay still binds the legacy tokens from its RECORDED values', () => {
  it('binds {{name}}/{{role}} and the closed set in one pass; a value holding a token stays literal', () => {
    expect(persona.applyRecordedVariables('{{name}}|{{role}}|{{worker.name}}', values)).toBe('Iris|tester|Iris');
    expect(persona.applyRecordedVariables('{{name}}|{{worker.name}}', { ...values, 'worker.name': '{{agent.name}}' })).toBe('{{agent.name}}|{{agent.name}}');
  });

  it('a record lacking either recorded key leaves the tokens as written, never "undefined"', () => {
    const { 'worker.role': _r, ...partial } = values;
    expect(persona.applyRecordedVariables('{{name}} {{role}} {{worker.name}}', partial as typeof values)).toBe('{{name}} {{role}} Iris');
  });

  it('the live binder still leaves them literal', () => {
    expect(persona.applyPlatformVariables('{{name}} {{role}}', values)).toBe('{{name}} {{role}}');
  });
});
