import { describe, expect, it } from 'vitest';
import {
  InvalidNodeRoleError,
  assertValidRuleRole,
  isValidRuleRole,
  resolveNodeRoleRule,
  roleIsOrDescendsFrom,
  roleRuleCandidates,
} from './governedRole.js';

describe('#1322 — dotted role primitives', () => {
  it('matches exact roles and dotted descendants, never textual prefixes', () => {
    expect(roleIsOrDescendsFrom('spec', 'spec')).toBe(true);
    expect(roleIsOrDescendsFrom('spec.rule', 'spec')).toBe(true);
    expect(roleIsOrDescendsFrom('spec.rule.detail', 'spec')).toBe(true);
    expect(roleIsOrDescendsFrom('special', 'spec')).toBe(false);
    expect(roleIsOrDescendsFrom('specification', 'spec')).toBe(false);
    expect(roleIsOrDescendsFrom(null, 'spec')).toBe(false);
  });

  it('walks lookup candidates one segment at a time, most specific first', () => {
    expect(roleRuleCandidates('spec.rule.detail')).toEqual([
      'spec.rule.detail',
      'spec.rule',
      'spec',
    ]);
    // Node.role is open: even a value that cannot be STORED as a rule key can
    // still fall outward to a valid base rule.
    expect(roleRuleCandidates('spec..detail')).toEqual(['spec..detail', 'spec.', 'spec']);
    expect(roleRuleCandidates('')).toEqual([]);
  });

  it('prefers the nearest enabled rule and skips disabled rows outward', () => {
    const rules = [
      { role: 'spec', enabled: true, marker: 'base' },
      { role: 'spec.rule', enabled: true, marker: 'rule' },
      { role: 'spec.rule.detail', enabled: false, marker: 'disabled-detail' },
      { role: 'review', enabled: true, marker: 'review' },
    ];

    expect(resolveNodeRoleRule('spec.rule', rules)?.marker).toBe('rule');
    expect(resolveNodeRoleRule('spec.rule.detail', rules)?.marker).toBe('rule');
    expect(resolveNodeRoleRule('spec.rule.detail.extra', rules)?.marker).toBe('rule');
    expect(resolveNodeRoleRule('spec.unknown', rules)?.marker).toBe('base');
    expect(resolveNodeRoleRule('spec..detail', rules)?.marker).toBe('base');
    expect(resolveNodeRoleRule('special', rules)).toBeNull();
    expect(resolveNodeRoleRule(null, rules)).toBeNull();
  });

  it('validates only rule keys: lower-case alphanumeric/dash segments, max 64', () => {
    for (const valid of ['spec', 'spec.rule', 'spec.rule-detail', 'r2.d3']) {
      expect(isValidRuleRole(valid), valid).toBe(true);
      expect(() => assertValidRuleRole(valid)).not.toThrow();
    }
    for (const invalid of [
      '',
      '.spec',
      'spec.',
      'spec..rule',
      'Spec.rule',
      'spec_rule',
      'spec rule',
      `a.${'b'.repeat(63)}`,
    ]) {
      expect(isValidRuleRole(invalid), invalid).toBe(false);
      expect(() => assertValidRuleRole(invalid)).toThrow(InvalidNodeRoleError);
    }
  });

  it('exposes the stable INVALID_NODE_ROLE error code', () => {
    try {
      assertValidRuleRole('Spec.rule');
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'InvalidNodeRoleError',
        extensions: { code: 'INVALID_NODE_ROLE', role: 'Spec.rule', maxLength: 64 },
      });
    }
  });
});
