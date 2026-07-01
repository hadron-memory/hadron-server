import { describe, it, expect } from 'vitest';
import { compileBooleanQuery, BooleanQueryError } from './tsquery.js';

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
});
