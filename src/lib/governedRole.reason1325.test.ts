/**
 * #1325(b) / hadron-cli#716 Q9 — INVALID_NODE_ROLE carries a structured
 * `reason` the CLI can branch on without parsing prose. Agreed with Dara
 * (team chat #1824) and Ada (#1826): additive to #1322's grammar, which it
 * does not change. One reason per key, by a fixed priority, with no repair.
 */
import { describe, it, expect } from 'vitest';
import {
  assertValidRuleRole,
  InvalidNodeRoleError,
  invalidRuleRoleReason,
  isValidRuleRole,
  RULE_ROLE_MAX_LENGTH,
} from './governedRole.js';

const thrown = (role: string) => {
  try {
    assertValidRuleRole(role);
  } catch (e) {
    return (e as InvalidNodeRoleError).extensions;
  }
  return null;
};

describe('#1325(b) — INVALID_NODE_ROLE reason', () => {
  it.each([
    ['', 'EMPTY'],
    [' ', 'BAD_SEGMENT'], // whitespace-only is not EMPTY: nothing is trimmed into validity
    ['spec_rule', 'BAD_SEGMENT'],
    ['spec..rule', 'BAD_SEGMENT'],
    ['.spec', 'BAD_SEGMENT'],
    ['spec.', 'BAD_SEGMENT'],
    ['Spec', 'BAD_SEGMENT'], // no lower-casing repair
    ['-spec', 'BAD_SEGMENT'],
    ['x'.repeat(RULE_ROLE_MAX_LENGTH + 1), 'TOO_LONG'],
    ['X'.repeat(RULE_ROLE_MAX_LENGTH + 1), 'TOO_LONG'], // multi-failure: length outranks the segment rule
  ])('%j → %s, with code, role and maxLength kept', (role, reason) => {
    expect(thrown(role)).toEqual({ code: 'INVALID_NODE_ROLE', role, reason, maxLength: RULE_ROLE_MAX_LENGTH });
  });

  it.each(['spec', 'spec.rule', 'a', 'x'.repeat(RULE_ROLE_MAX_LENGTH), 'review.a-b.c9'])('%j is valid: no reason, no throw', (role) => {
    expect(invalidRuleRoleReason(role)).toBeNull();
    expect(thrown(role)).toBeNull();
  });

  it('the reason and the boolean grammar never disagree', () => {
    const table = ['', ' ', 'a', 'A', 'a.b', 'a..b', 'a_b', 'a-b', '-a', 'a.', '9', 'x'.repeat(64), 'x'.repeat(65), 'spec.RULE'];
    for (const role of table) expect(invalidRuleRoleReason(role) === null, role).toBe(isValidRuleRole(role));
  });
});
