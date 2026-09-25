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

    const marker = (role: string | null) => {
      const r = resolveNodeRoleRule(role, rules);
      return r.kind === 'RULE' ? r.rule.marker : r.kind;
    };
    expect(marker('spec.rule')).toBe('rule');
    expect(marker('spec.rule.detail')).toBe('rule');
    expect(marker('spec.rule.detail.extra')).toBe('rule');
    expect(marker('spec.unknown')).toBe('base');
    expect(marker('spec..detail')).toBe('base');
    expect(marker('special')).toBe('NONE');
    expect(marker(null)).toBe('NONE');
  });

  // #1345 review (@copilot) — Holger's H1: a strict parent REFUSES undeclared
  // sub-roles instead of lending them its rule.
  describe('strictSubRoles (H1)', () => {
    const rules = [
      { role: 'spec', enabled: true, strictSubRoles: true, marker: 'base' },
      { role: 'spec.rule', enabled: true, strictSubRoles: false, marker: 'rule' },
      { role: 'spec.draft', enabled: false, strictSubRoles: false, marker: 'draft-off' },
      { role: 'review', enabled: true, strictSubRoles: false, marker: 'review' },
    ];
    const resolve = (role: string) => resolveNodeRoleRule(role, rules);

    it('an undeclared sub-role of a strict parent is refused, naming the parent', () => {
      expect(resolve('spec.unknown')).toEqual({ kind: 'UNDECLARED_UNDER_STRICT', ancestor: rules[0] });
      expect(resolve('spec.a.b')).toEqual({ kind: 'UNDECLARED_UNDER_STRICT', ancestor: rules[0] });
    });

    it('the strict parent itself, and its declared sub-roles, resolve normally', () => {
      expect(resolve('spec')).toEqual({ kind: 'RULE', rule: rules[0] });
      expect(resolve('spec.rule')).toEqual({ kind: 'RULE', rule: rules[1] });
    });

    it('strictness is the NEAREST enabled rule\'s: a non-strict declared child governs its own descendants', () => {
      expect(resolve('spec.rule.x')).toEqual({ kind: 'RULE', rule: rules[1] });
    });

    it('a declared-but-disabled sub-role is declared: it falls back to the strict parent\'s rule, not a refusal', () => {
      expect(resolve('spec.draft')).toEqual({ kind: 'RULE', rule: rules[0] });
    });

    it('a disabled strict rule governs nothing, strictness included', () => {
      const off = [{ role: 'spec', enabled: false, strictSubRoles: true }];
      expect(resolveNodeRoleRule('spec.unknown', off)).toEqual({ kind: 'NONE' });
    });

    it('unrelated roles stay free, and a non-strict parent still lends its rule', () => {
      expect(resolve('special')).toEqual({ kind: 'NONE' });
      expect(resolve('review.x')).toEqual({ kind: 'RULE', rule: rules[3] });
    });
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
