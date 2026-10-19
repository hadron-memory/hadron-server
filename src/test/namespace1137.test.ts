/** Destructive-site probes use a recording pg client; no shared DB is dropped. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerDbName, runTemplateDbName } from './dbWorkers.js';
import { prepareRunGraphRoot, removeRunGraphRoot, runGraphRoot } from './graphRoot.js';

const record = vi.hoisted(() => ({ names: [] as string[], sql: [] as string[] }));
vi.mock('pg', () => ({ Client: class {
  connect = async () => {}; end = async () => {};
  query = async (q: string) => { record.sql.push(q); return { rows: record.names.map(datname => ({ datname })), rowCount: 0 }; };
} }));
vi.mock('./schemaTemplate.js', () => ({ ensureSchemaTemplate: async () => 'b_s0123456789abcdef', assertBaseMatchesSchema: async () => {} }));
import { Client } from 'pg';
import { provisionParallel, dropOrphanWorkerDbs } from './globalSetup.js';

const oldScope = process.env.HADRON_TEST_RUN_SCOPE;
const a = 'l' + 'a'.repeat(20), b = 'l' + 'b'.repeat(20);
const inScope = <T>(scope: string, f: () => T): T => { process.env.HADRON_TEST_RUN_SCOPE = scope; return f(); };
const name = (scope: string, pid: string, pool: number | 'tpl') => inScope(scope, () => pool === 'tpl' ? runTemplateDbName(pid, 'b') : workerDbName(pool, 'b', pid));
afterEach(() => { if (oldScope === undefined) delete process.env.HADRON_TEST_RUN_SCOPE; else process.env.HADRON_TEST_RUN_SCOPE = oldScope; record.names = []; record.sql = []; });

describe('#1137 same pid, distinct namespace ownership', () => {
  it('does not share worker clones or run templates for the same pid', () => {
    expect(name(a,'1',1)).not.toBe(name(b,'1',1));
    expect(name(a,'1','tpl')).not.toBe(name(b,'1','tpl'));
  });
  it('startup DROP never targets the other namespace template with the same pid', async () => {
    const foreign = name(b,'1','tpl');
    process.env.HADRON_TEST_RUN_SCOPE = a;
    await provisionParallel(new Client(), 'b', '1');
    expect(record.sql.filter(q => q.startsWith('DROP DATABASE'))).not.toContain(`DROP DATABASE IF EXISTS "${foreign}" WITH (FORCE)`);
  });
  it('sweep and own-name reset preserve foreign same-pid and absent-local-pid clones', async () => {
    const foreign = [name(b,'1',1), name(b,'2147483647',2)];
    record.names = foreign;
    process.env.HADRON_TEST_RUN_SCOPE = a;
    await dropOrphanWorkerDbs(new Client(), 'b', '1');
    expect(record.sql.filter(q => q.startsWith('DROP DATABASE'))).toEqual([]);
  });
  it('teardown compares the full token instead of the pid', async () => {
    const foreign = name(b,'1',1);
    process.env.HADRON_TEST_RUN_SCOPE = a;
    const teardown = await provisionParallel(new Client(), 'b', '1');
    record.sql = []; record.names = [foreign];
    await teardown();
    expect(record.sql.filter(q => q.startsWith('DROP DATABASE'))).toEqual([]);
  });
  it('graph startup/sweep/teardown cannot reuse or remove a foreign same-pid root', () => {
    const parent = mkdtempSync(join(tmpdir(),'namespace1137-'));
    try {
      const foreign = inScope(b, () => runGraphRoot('1',parent));
      mkdirSync(foreign, {recursive:true});
      process.env.HADRON_TEST_RUN_SCOPE = a;
      const own = prepareRunGraphRoot('1',parent);
      expect(own).not.toBe(foreign);
      removeRunGraphRoot('1',parent);
      expect(existsSync(foreign)).toBe(true);
    } finally { rmSync(parent,{recursive:true,force:true}); }
  });
});
