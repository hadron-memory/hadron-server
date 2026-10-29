/** #2702: the legacy {{name}} / {{role}} values for served text come from the values the text is bound with. */
import { describe, expect, it } from 'vitest';
import { applyPlatformVariables, legacyFromValues } from './personaDescription.js';

describe('#2702 legacyFromValues', () => {
  it('takes name and role from worker.name / worker.role', () => {
    expect(legacyFromValues({ 'worker.name': 'Iris', 'worker.role': 'tester' })).toEqual({ name: 'Iris', role: 'tester' });
  });

  it('a record lacking either key leaves the legacy tokens as written, never "undefined"', () => {
    expect(legacyFromValues({ 'worker.name': 'Iris' })).toBeUndefined();
    expect(legacyFromValues({ 'worker.role': 'tester' })).toBeUndefined();
    const values = { 'worker.name': 'Iris' } as never;
    expect(applyPlatformVariables('{{name}} / {{role}}', values, legacyFromValues(values))).toBe('{{name}} / {{role}}');
  });
});
