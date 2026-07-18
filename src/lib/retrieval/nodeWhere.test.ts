/**
 * Unit tests for the node `where` predicate compiler (#719). Pure — asserts the
 * generated SQL string + bound params without a database. Injection safety,
 * cast routing, and the DoS caps are the load-bearing cases.
 */
import { describe, it, expect } from 'vitest';
import {
  compileNodeWhere,
  NodeWhereError,
  WHERE_MAX_DEPTH,
  WHERE_MAX_LEAVES,
  type NodeWhere,
} from './nodeWhere.js';

/** A recording `bind` mirroring postgres.ts's paramBuilder ($1-based). */
function mkBind() {
  const params: unknown[] = [];
  return { params, bind: (v: unknown) => `$${params.push(v)}` };
}

/** Compile with a fresh binder; return { sql, params }. */
function compile(pred: NodeWhere, defaultColumn?: 'properties' | 'data') {
  const { params, bind } = mkBind();
  const sql = compileNodeWhere(pred, bind, defaultColumn ? { defaultColumn } : {});
  return { sql, params };
}

describe('compileNodeWhere — leaves', () => {
  it('eq on properties defaults to text extraction + bound value', () => {
    const { sql, params } = compile({ path: ['sourceKind'], eq: 'substack' });
    expect(sql).toBe(`(properties #>> ARRAY['sourceKind']::text[]) = $1`);
    expect(params).toEqual(['substack']);
  });

  it('honors the field selector (data column)', () => {
    const { sql } = compile({ field: 'data', path: ['tools'], exists: true });
    expect(sql).toBe(`(data #> ARRAY['tools']::text[]) IS NOT NULL`);
  });

  it('defaultColumn overrides the implicit properties column', () => {
    const { sql } = compile({ path: ['k'], eq: 'v' }, 'data');
    expect(sql).toBe(`(data #>> ARRAY['k']::text[]) = $1`);
  });

  it('datetime cast routes the LHS through the guard function and casts the RHS', () => {
    const { sql, params } = compile({ path: ['extractedAt'], as: 'datetime', gte: '2026-07-01T00:00:00Z' });
    expect(sql).toBe(
      `hadron_safe_timestamptz((properties #>> ARRAY['extractedAt']::text[])) >= $1::timestamptz`,
    );
    expect(params).toEqual(['2026-07-01T00:00:00Z']);
  });

  it('number cast routes through hadron_safe_numeric and ::numeric', () => {
    const { sql, params } = compile({ path: ['confidence'], as: 'number', lt: 0.5 });
    expect(sql).toBe(`hadron_safe_numeric((properties #>> ARRAY['confidence']::text[])) < $1::numeric`);
    expect(params).toEqual([0.5]);
  });

  it('number cast accepts a numeric string', () => {
    const { params } = compile({ path: ['n'], as: 'number', eq: '42' });
    expect(params).toEqual([42]);
  });

  it('ne uses IS DISTINCT FROM so missing keys are returned', () => {
    const { sql } = compile({ path: ['status'], ne: 'closed' });
    expect(sql).toBe(`(properties #>> ARRAY['status']::text[]) IS DISTINCT FROM $1`);
  });

  it('in emits one placeholder per item', () => {
    const { sql, params } = compile({ path: ['lens'], in: ['gap', 'technique', 'trend'] });
    expect(sql).toBe(`(properties #>> ARRAY['lens']::text[]) IN ($1, $2, $3)`);
    expect(params).toEqual(['gap', 'technique', 'trend']);
  });

  it('between emits BETWEEN with two bound values', () => {
    const { sql, params } = compile({ path: ['occurredAt'], as: 'datetime', between: ['2026-01-01', '2026-12-31'] });
    expect(sql).toBe(
      `hadron_safe_timestamptz((properties #>> ARRAY['occurredAt']::text[])) BETWEEN $1::timestamptz AND $2::timestamptz`,
    );
    expect(params).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('exists:false becomes IS NULL', () => {
    const { sql } = compile({ path: ['funding'], exists: false });
    expect(sql).toBe(`(properties #> ARRAY['funding']::text[]) IS NULL`);
  });

  it('contains uses jsonb @> with a stringified param', () => {
    const { sql, params } = compile({ path: ['actors'], contains: ['acme'] });
    expect(sql).toBe(`(properties #> ARRAY['actors']::text[]) @> $1::jsonb`);
    expect(params).toEqual(['["acme"]']);
  });

  it('boolean cast compares the rendered text', () => {
    const { sql, params } = compile({ path: ['active'], as: 'boolean', eq: true });
    expect(sql).toBe(`(properties #>> ARRAY['active']::text[]) = $1`);
    expect(params).toEqual(['true']);
  });

  it('multi-segment path is inlined as a quoted text[]', () => {
    const { sql } = compile({ path: ['a', 'b', 'c'], eq: 'x' });
    expect(sql).toContain(`ARRAY['a', 'b', 'c']::text[]`);
  });
});

describe('compileNodeWhere — branches', () => {
  it('and joins children, parenthesized', () => {
    const { sql, params } = compile({
      and: [
        { path: ['sourceKind'], eq: 'substack' },
        { path: ['extractedAt'], as: 'datetime', gte: '2026-07-04T00:00:00Z' },
      ],
    });
    expect(sql).toBe(
      `((properties #>> ARRAY['sourceKind']::text[]) = $1 AND ` +
        `hadron_safe_timestamptz((properties #>> ARRAY['extractedAt']::text[])) >= $2::timestamptz)`,
    );
    expect(params).toEqual(['substack', '2026-07-04T00:00:00Z']);
  });

  it('or joins with OR', () => {
    const { sql } = compile({ or: [{ path: ['a'], eq: '1' }, { path: ['b'], eq: '2' }] });
    expect(sql).toBe(
      `((properties #>> ARRAY['a']::text[]) = $1 OR (properties #>> ARRAY['b']::text[]) = $2)`,
    );
  });

  it('not wraps its child', () => {
    const { sql } = compile({ not: { path: ['status'], eq: 'closed' } });
    expect(sql).toBe(`(NOT (properties #>> ARRAY['status']::text[]) = $1)`);
  });

  it('nests and/or/not to depth', () => {
    const { sql } = compile({
      and: [{ path: ['x'], eq: '1' }, { or: [{ path: ['y'], eq: '2' }, { not: { path: ['z'], exists: true } }] }],
    });
    expect(sql).toContain(' AND ');
    expect(sql).toContain(' OR ');
    expect(sql).toContain('NOT');
  });
});

describe('compileNodeWhere — validation & safety', () => {
  it('rejects a path segment with a quote (injection attempt)', () => {
    expect(() => compile({ path: [`x') OR ('1'='1`], eq: 'v' })).toThrow(NodeWhereError);
  });

  it('rejects a path segment with a semicolon', () => {
    expect(() => compile({ path: ['a;DROP TABLE nodes'], eq: 'v' })).toThrow(NodeWhereError);
  });

  it('rejects an unknown field column', () => {
    // @ts-expect-error deliberately invalid column
    expect(() => compile({ field: 'content', path: ['x'], eq: 'v' })).toThrow(NodeWhereError);
  });

  it('rejects a leaf with no operator', () => {
    expect(() => compile({ path: ['x'] })).toThrow(NodeWhereError);
  });

  it('rejects a leaf with two operators', () => {
    expect(() => compile({ path: ['x'], eq: 'a', ne: 'b' })).toThrow(NodeWhereError);
  });

  it('rejects a node that is both a branch and a leaf', () => {
    expect(() => compile({ and: [{ path: ['x'], eq: '1' }], eq: 'y' } as NodeWhere)).toThrow(NodeWhereError);
  });

  it('rejects more than one branch key', () => {
    expect(() =>
      compile({ and: [{ path: ['x'], eq: '1' }], or: [{ path: ['y'], eq: '2' }] } as NodeWhere),
    ).toThrow(NodeWhereError);
  });

  it('rejects an empty branch array', () => {
    expect(() => compile({ and: [] })).toThrow(NodeWhereError);
  });

  it('rejects a leaf with an empty path', () => {
    expect(() => compile({ path: [], eq: 'v' })).toThrow(NodeWhereError);
  });

  it('rejects a number cast against a non-numeric value', () => {
    expect(() => compile({ path: ['n'], as: 'number', eq: 'not-a-number' })).toThrow(NodeWhereError);
  });

  it('enforces the max depth', () => {
    // Build a not-chain one level deeper than allowed.
    let node: NodeWhere = { path: ['x'], eq: '1' };
    for (let i = 0; i < WHERE_MAX_DEPTH; i++) node = { not: node };
    expect(() => compile(node)).toThrow(/max depth/);
  });

  it('enforces the max leaf count', () => {
    const many: NodeWhere = { and: Array.from({ length: WHERE_MAX_LEAVES + 1 }, (_, i) => ({ path: [`k${i}`], eq: 'v' })) };
    expect(() => compile(many)).toThrow(/leaf predicates/);
  });

  it('enforces the max path length', () => {
    expect(() => compile({ path: Array.from({ length: 9 }, (_, i) => `a${i}`), eq: 'v' })).toThrow(/path exceeds/);
  });

  it('rejects between without exactly two elements', () => {
    expect(() => compile({ path: ['x'], as: 'number', between: [1, 2, 3] })).toThrow(NodeWhereError);
  });
});
