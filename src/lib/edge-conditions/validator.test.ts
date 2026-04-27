import { describe, it, expect } from 'vitest';
import { validateEdgeCondition } from './validator.js';

describe('edge-conditions / validateEdgeCondition', () => {
  describe('null and trivial conditions', () => {
    it('accepts null', () => {
      expect(validateEdgeCondition(null)).toEqual({ ok: true });
    });

    it('accepts undefined', () => {
      expect(validateEdgeCondition(undefined)).toEqual({ ok: true });
    });

    it('accepts a literal boolean', () => {
      expect(validateEdgeCondition(true)).toEqual({ ok: true });
    });

    it('accepts a literal number', () => {
      expect(validateEdgeCondition(42)).toEqual({ ok: true });
    });
  });

  describe('v1 operators (allowed)', () => {
    it.each([
      ['equality', { '==': [{ var: 'memory.business_type' }, 'tech'] }],
      ['inequality', { '!=': [{ var: 'chat.message_count' }, 0] }],
      ['less than', { '<': [{ var: 'memory.runway_months' }, 3] }],
      ['greater than', { '>': [{ var: 'chat.message_count' }, 20] }],
      ['and', { and: [{ '==': [{ var: 'memory.x' }, 1] }, { '==': [{ var: 'memory.y' }, 2] }] }],
      ['or', { or: [{ missing: ['memory.business_type'] }, { '<': [{ var: 'memory.runway_months' }, 3] }] }],
      ['not', { '!': { '==': [{ var: 'memory.stage' }, 'idea'] } }],
      ['in', { in: [{ var: 'memory.industry' }, ['tech', 'healthcare', 'retail']] }],
      ['missing', { missing: ['memory.business_type', 'memory.team_size'] }],
      ['missing_some', { missing_some: [1, ['memory.a', 'memory.b', 'memory.c']] }],
      ['arithmetic +', { '<': [{ '+': [{ var: 'memory.a' }, { var: 'memory.b' }] }, 100] }],
      ['arithmetic *', { '<': [{ var: 'memory.x' }, { '*': [{ var: 'memory.target' }, 0.8] }] }],
    ])('accepts %s', (_name, condition) => {
      const result = validateEdgeCondition(condition);
      expect(result.ok).toBe(true);
    });
  });

  describe('disallowed operators', () => {
    it.each([
      ['cat'],
      ['substr'],
      ['min'],
      ['max'],
      ['map'],
      ['reduce'],
      ['filter'],
      ['if'],
      ['log'],
    ])('rejects %s', (op) => {
      const condition = { [op]: [1, 2] };
      const result = validateEdgeCondition(condition);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('DISALLOWED_OPERATOR');
        expect(result.error.detail.operator).toBe(op);
      }
    });
  });

  describe('unknown scope', () => {
    it('rejects a var path with no scope prefix', () => {
      const result = validateEdgeCondition({ var: 'business_type' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN_SCOPE');
        expect(result.error.detail.field).toBe('business_type');
      }
    });

    it('rejects a var path with a made-up scope', () => {
      const result = validateEdgeCondition({ var: 'session.foo' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN_SCOPE');
    });

    it('accepts builtins now() and today()', () => {
      expect(validateEdgeCondition({ var: 'now()' }).ok).toBe(true);
      expect(validateEdgeCondition({ var: 'today()' }).ok).toBe(true);
    });

    it('rejects unknown scope inside missing', () => {
      const result = validateEdgeCondition({ missing: ['business_type', 'memory.team_size'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN_SCOPE');
    });
  });

  describe('reserved names', () => {
    it.each([
      'message.data.exception',
      'message.data.exception.code',
      'message.data.exceptions',
      'message.data.exceptions.0',
    ])('rejects var path %s', (path) => {
      const result = validateEdgeCondition({ var: path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('RESERVED_NAME');
        expect(result.error.detail.field).toBe(path);
      }
    });

    it('still accepts message.data.exception_count (different field, not reserved)', () => {
      const result = validateEdgeCondition({ var: 'message.data.exception_count' });
      expect(result.ok).toBe(true);
    });
  });

  describe('AST limits', () => {
    it('rejects conditions over 8 KB', () => {
      const huge = { '==': [{ var: 'memory.x' }, 'a'.repeat(9000)] };
      const result = validateEdgeCondition(huge);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('AST_TOO_LARGE');
    });

    it('rejects conditions nested deeper than 10 levels', () => {
      let nested: unknown = { var: 'memory.x' };
      for (let i = 0; i < 12; i++) {
        nested = { '!': nested };
      }
      const result = validateEdgeCondition(nested);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('AST_TOO_DEEP');
    });
  });

  describe('JSONLogic shape', () => {
    it('rejects an object with multiple keys (not a valid operator node)', () => {
      const result = validateEdgeCondition({ '==': [1, 1], '!=': [1, 2] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_JSONLOGIC');
    });

    it('accepts an empty object (degenerate but harmless)', () => {
      const result = validateEdgeCondition({});
      expect(result.ok).toBe(true);
    });
  });
});
