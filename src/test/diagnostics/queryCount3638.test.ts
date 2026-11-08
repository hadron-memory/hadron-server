import { expect, it } from 'vitest';
import { QueryCount3638 } from './queryCount3638.js';
it('counts every statement, not unique SQL text, and ignores events outside the span', () => {
    const c = new QueryCount3638();
    c.record('SELECT * FROM "users"');
    c.begin();
    c.record('SELECT * FROM "agents"');
    c.record('SELECT * FROM "agents"');
    c.record('BEGIN');
    expect(c.end()).toEqual({ sqlCount: 3, tables: { agents: 2 } });
    c.record('COMMIT');
    c.begin();
    expect(c.end()).toEqual({ sqlCount: 0, tables: {} });
});
it('classifies joined tables without counting repeated references twice per statement', () => {
    const c = new QueryCount3638();
    c.begin();
    c.record('SELECT a.id FROM "public"."agents" a JOIN "public"."org_members" m ON true JOIN "public"."agents" b ON true');
    expect(c.end()).toEqual({ sqlCount: 1, tables: { agents: 1, org_members: 1 } });
});
it('refuses overlapping or missing spans instead of mixing campaign records', () => {
    const c = new QueryCount3638();
    expect(() => c.end()).toThrow('no diagnostic span');
    c.begin();
    expect(() => c.begin()).toThrow('overlapping');
    c.end();
});
it('classifies quoted tables across simple FROM/JOIN/UPDATE/INTO forms without claiming SQL parsing', () => {
    const c = new QueryCount3638();
    c.begin();
    c.record('update "other"."Agent2" set x = 1');
    c.record('insert into "public"."node2" (x) values (1)');
    c.record('delete from "public"."node3" where true');
    c.record('select * from unquoted_table');
    expect(c.end()).toEqual({ sqlCount: 4, tables: { Agent2: 1, node2: 1, node3: 1 } });
});
