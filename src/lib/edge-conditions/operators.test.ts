import { describe, it, expect } from 'vitest';
import {
  V1_OPERATORS,
  V1_OPERATORS_SET,
  VALID_SCOPE_PREFIXES,
  VALID_BUILTINS,
  RESERVED_VAR_PATHS,
} from './operators.js';

describe('edge-conditions / operators allowlist', () => {
  it('exports exactly 17 v1 operators', () => {
    expect(V1_OPERATORS).toHaveLength(17);
  });

  it('includes every category — comparison, logical, membership, var/missing, arithmetic', () => {
    for (const op of [
      '==', '!=', '<', '<=', '>', '>=',
      'and', 'or', '!',
      'in',
      'var', 'missing', 'missing_some',
      '+', '-', '*', '/',
    ]) {
      expect(V1_OPERATORS_SET.has(op)).toBe(true);
    }
  });

  it('does not include common JSONLogic operators that are out of v1 scope', () => {
    for (const op of ['cat', 'substr', 'min', 'max', 'map', 'reduce', 'filter', 'if', 'log', '?:']) {
      expect(V1_OPERATORS_SET.has(op)).toBe(false);
    }
  });

  it('exposes the four valid scope prefixes', () => {
    expect(VALID_SCOPE_PREFIXES).toEqual(['memory.', 'chat.', 'agent.', 'message.data.']);
  });

  it('exposes the two time builtins', () => {
    expect(VALID_BUILTINS).toEqual(['now()', 'today()']);
  });

  it('reserves message.data.exception(s) for the future exceptions feature', () => {
    expect(RESERVED_VAR_PATHS).toContain('message.data.exception');
    expect(RESERVED_VAR_PATHS).toContain('message.data.exceptions');
  });
});
