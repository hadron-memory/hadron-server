import { describe, it, expect } from 'vitest';
import { compileBooleanQuery, literalQuery, BooleanQueryError } from './tsquery.js';

describe('compileBooleanQuery', () => {
  it('compiles a single term to a bound plainto_tsquery', () => {
    const r = compileBooleanQuery('memory', 4);
    expect(r.sql).toBe("plainto_tsquery('english', $4)");
    expect(r.params).toEqual(['memory']);
  });

  it('compiles the motivating grouped boolean query', () => {
    const r = compileBooleanQuery('(banana OR apple) AND shake', 4);
    expect(r.sql).toBe(
      "((plainto_tsquery('english', $4) || plainto_tsquery('english', $5)) && plainto_tsquery('english', $6))",
    );
    expect(r.params).toEqual(['banana', 'apple', 'shake']);
  });

  it('treats adjacent terms as implicit AND', () => {
    const r = compileBooleanQuery('memory graph', 1);
    expect(r.sql).toBe("(plainto_tsquery('english', $1) && plainto_tsquery('english', $2))");
    expect(r.params).toEqual(['memory', 'graph']);
  });

  it('handles quoted phrases via phraseto_tsquery', () => {
    const r = compileBooleanQuery('"vector index" OR hnsw', 4);
    expect(r.sql).toBe(
      "(phraseto_tsquery('english', $4) || plainto_tsquery('english', $5))",
    );
    expect(r.params).toEqual(['vector index', 'hnsw']);
  });

  it('supports NOT and leading-dash negation', () => {
    const a = compileBooleanQuery('memory NOT chat', 4);
    expect(a.sql).toBe("(plainto_tsquery('english', $4) && (!! plainto_tsquery('english', $5)))");
    const b = compileBooleanQuery('memory -chat', 4);
    expect(b.sql).toBe(a.sql);
    expect(b.params).toEqual(['memory', 'chat']);
  });

  it('respects OR-below-AND precedence', () => {
    const r = compileBooleanQuery('a AND b OR c', 1);
    // (a && b) || c
    expect(r.sql).toBe(
      "((plainto_tsquery('english', $1) && plainto_tsquery('english', $2)) || plainto_tsquery('english', $3))",
    );
  });

  it.each([
    ['', 'empty'],
    ['(banana OR apple', 'unbalanced ('],
    ['banana OR apple)', 'unbalanced )'],
    ['AND memory', 'leading AND'],
    ['memory OR', 'trailing OR'],
    ['NOT', 'NOT with no operand'],
    ['"unterminated', 'unterminated phrase'],
  ])('throws BooleanQueryError on malformed input: %s', (input) => {
    expect(() => compileBooleanQuery(input, 4)).toThrow(BooleanQueryError);
  });

  // Operator words are UPPERCASE-ONLY (the search-engine convention) so
  // natural-language input is never silently rewritten into a boolean
  // expression.
  it('treats lowercase not/or/and as plain terms — "not sure" does not negate', () => {
    const r = compileBooleanQuery('not sure', 1);
    expect(r.sql).not.toContain('!!');
    expect(r.params).toEqual(['not', 'sure']);
    const o = compileBooleanQuery('cats or dogs', 1);
    expect(o.sql).not.toContain('||');
    expect(o.params).toEqual(['cats', 'or', 'dogs']);
    // Mixed case is a plain term too.
    const m = compileBooleanQuery('Not sure', 1);
    expect(m.sql).not.toContain('!!');
  });

  it('uppercase operators still work', () => {
    expect(compileBooleanQuery('NOT sure', 1).sql).toContain('!!');
    expect(compileBooleanQuery('cats OR dogs', 1).sql).toContain('||');
  });

  describe('literalQuery — the always-parseable literal form', () => {
    it('wraps raw text as a single phrase leaf', () => {
      const r = compileBooleanQuery(literalQuery('not sure (about this'), 1);
      expect(r.sql).toBe("phraseto_tsquery('english', $1)");
      expect(r.params).toEqual(['not sure (about this']);
    });

    it.each([
      '(banana OR apple',
      '"unterminated',
      'memory OR',
      'weird "mid"quote text',
      'NOT',
    ])('never throws, even for previously-malformed input: %s', (input) => {
      expect(() => compileBooleanQuery(literalQuery(input), 1)).not.toThrow();
    });
  });
});
