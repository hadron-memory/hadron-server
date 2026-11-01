import { describe, expect, it } from 'vitest';
import { matchingModelGroupNames } from './modelGroups.js';

describe('opaque model-group globs', () => {
  it.each([
    ['a.b', 'axb', false], ['a.b', 'a.b', true], ['model-*', 'prefix-model-x', false],
    ['model-?', 'model-ab', false], ['model-?', 'model-a', true], ['model-*', 'model-', true],
    ['*a*b', 'aaab', true], ['*a*b', 'aaabc', false], ['a**?', 'ab', true],
    ['model', ' MODEL ', true], [' MODEL-* ', 'model-x', true], ['*b', '*xb', true], ['a*b', 'a*xb', true], ['*', '', false], ['*', null, false],
    ['a/b:@_-', 'a/b:@_-', true],
  ])('%s against %s matches %s', (pattern, model, matches) => {
    expect(matchingModelGroupNames([{ name: 'opaque', patterns: [pattern], origin: 'APP' }], model)).toEqual(matches ? ['opaque'] : []);
  });
  it('deduplicates a matching group even if several patterns match, sorted by name', () => {
    expect(matchingModelGroupNames([
      { name: 'z', patterns: ['*', 'model'], origin: 'AGENT' },
      { name: 'a', patterns: ['model'], origin: 'APP_OVERRIDE' },
      { name: 'disabled', patterns: [], origin: 'APP_OVERRIDE' },
    ], 'model')).toEqual(['a', 'z']);
  });
});
