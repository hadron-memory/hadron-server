/**
 * #4111 contract sections B and C (pipeline rows P1-P12, and R6/R7 on a real restore): `restore-with-rebase` against
 * two PRIVATE throwaway clusters. Source A has its xid counter moved to ~1,000,000 with `pg_resetwal -x` (a throwaway
 * cluster only), so its keys are "H" on the fresh target B (xmax ~2,000). B carries the operator prerequisites P1/P2.
 *
 * Skipped where no PostgreSQL server binaries with pgvector are installed (initdb, pg_ctl, pg_resetwal, vector.control);
 * hosted CI is such a runner, so this suite runs on a developer or QA host with the two private clusters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { startPrivateCluster, pgBinDir, type PrivateCluster } from './privateCluster.js';
import * as F from './restoreFixture.js';
import {
  filterToc,
  readSourceDbSettings,
  restoreWithRebase,
  RestoreError,
  status,
  teardown,
  tocExtensions,
  type RunOptions,
} from './restore-with-rebase.js';
import {
  assertEventKeysLocal,
  ForeignEventKeyError,
  rebaseEventKeys,
  RebaseHeadroomError,
  withAppendOnlyTriggerOff,
} from '../../src/lib/agentTasks/eventKeyRebase.js';

const enabled = pgBinDir() !== null;
let A: PrivateCluster;
let B: PrivateCluster;
let dumps: { full: string; noKey: string; extra: string; manyRuns: string };
let sourceOrder: { id: string; k: string }[];
let n = 0;
const fresh = () => `restored_${++n}`;

const base = (over: Partial<RunOptions> = {}): RunOptions => ({
  adminUrl: F.adminUrl(B),
  dump: dumps.full,
  target: fresh(),
  ownerRole: F.ROLES.owner,
  template: F.TEMPLATE,
  serveRole: F.ROLES.serve,
  connectionLimit: 20,
  dbSettings: {},
  log: () => undefined,
  ...over,
});
const dbExists = async (name: string) =>
  (await F.sql(B.url(), 'SELECT 1 FROM pg_database WHERE datname = $1', [name])).length > 0;
const pgQueryable = (url: string) => ({
  async $queryRawUnsafe<T>(text: string): Promise<T> {
    return (await F.sql(url, text)) as T;
  },
});
async function tryConnect(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!enabled) return;
  A = await startPrivateCluster('src4111');
  B = await startPrivateCluster('dst4111');
  A.setNextXid(1_000_000n);
  await F.buildSchema(A, 'hadron');
  const src = A.url('hadron');
  // A mixed history: legacy '0' keys, explicit small keys (L on B), this cluster's ~1,000,000 keys (H on B), backdated
  // stamps (several runs), and a multi-row transaction.
  const one = await F.seedApp(src, 'One');
  const two = await F.seedApp(src, 'Two');
  await F.sql(
    src,
    `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at, tx_id) VALUES
       ('evtzero1', $1, 'task.assigned', $2, '{"type":"task.assigned"}', now() - interval '9 days', '0'),
       ('evtzero2', $1, 'task.assigned', $2, '{"type":"task.assigned"}', now() - interval '8 days', '0'),
       ('evtlow01', $1, 'task.assigned', $2, '{"type":"task.assigned"}', now() - interval '7 days', '100'),
       ('evtlow02', $3, 'task.assigned', $4, '{"type":"task.assigned"}', now() - interval '6 days', '100'),
       ('evtlow03', $3, 'task.assigned', $4, '{"type":"task.assigned"}', now() - interval '10 days', '150')`,
    [one.appId, one.taskId, two.appId, two.taskId],
  );
  for (const [app, off] of [[one, '0 s'], [two, '-1 hour'], [one, '+1 hour'], [two, '-2 hours'], [one, '-3 days']] as const) {
    await F.event(src, app.appId, app.taskId, off);
  }
  await F.sql(
    src,
    `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at)
     SELECT 'evtbatch' || g, $1, 'task.assigned', $2, '{"type":"task.assigned"}', now() - g * interval '1 minute'
       FROM generate_series(1, 4) g`,
    [one.appId, one.taskId],
  );
  // A role only the source has, holding a grant: --no-privileges must leave it behind.
  await F.sql(A.url(), `CREATE ROLE src_reader`);
  await F.sql(src, `GRANT SELECT ON nodes TO src_reader`);
  await F.sql(A.url(), `ALTER DATABASE hadron SET work_mem = '8MB'`);
  sourceOrder = await F.servingOrder(src);
  dumps = {
    full: `${A.dir}/full.dump`,
    noKey: `${A.dir}/nokey.dump`,
    extra: `${A.dir}/extra.dump`,
    manyRuns: `${A.dir}/manyruns.dump`,
  };
  F.dump(A, 'hadron', dumps.full);

  // An older image's database: no tx_id column at all.
  await F.sql(A.url(), `CREATE DATABASE hadron_old TEMPLATE hadron`);
  await F.sql(A.url('hadron_old'), `ALTER TABLE agent_team_events DROP COLUMN tx_id`);
  F.dump(A, 'hadron_old', dumps.noKey);
  // A fourth extension the template lacks.
  await F.sql(A.url(), `CREATE DATABASE hadron_extra TEMPLATE hadron`);
  await F.sql(A.url('hadron_extra'), `CREATE EXTENSION citext`);
  F.dump(A, 'hadron_extra', dumps.extra);
  // More runs than the target's headroom: keys ascending while stamps descend, so every row is its own run.
  await F.sql(A.url(), `CREATE DATABASE hadron_many TEMPLATE hadron`);
  await F.sql(
    A.url('hadron_many'),
    `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at, tx_id)
     SELECT 'evtmany' || lpad(g::text, 6, '0'), $1, 'task.assigned', $2, '{"type":"task.assigned"}',
            now() - g * interval '1 second', (2000000 + g)::text::xid8
       FROM generate_series(1, 200000) g`,
    [one.appId, one.taskId],
  );
  F.dump(A, 'hadron_many', dumps.manyRuns);

  await F.provisionTarget(B);
}, 300_000);

afterAll(() => {
  A?.destroy();
  B?.destroy();
});

describe.skipIf(!enabled)('#4111 restore-with-rebase on private clusters', { timeout: 120_000 }, () => {
  it('R1/R7/P4/P8/P11: restores a mixed L/H history in exact source order, owner-owned, no dump ACLs, settings applied', async () => {
    expect(sourceOrder.some((r) => BigInt(r.k) >= 1_000_000n)).toBe(true);
    const target = fresh();
    const settings = await readSourceDbSettings(A.url('hadron'));
    expect(settings).toEqual({ work_mem: '8MB' });
    const res = await restoreWithRebase(base({ target, dbSettings: settings }));
    expect(res.status).toBe('RELEASED');
    expect(res.rebase).toMatchObject({ state: 'rebased' });
    const url = B.url(target);
    const after = await F.servingOrder(url);
    expect(after.map((r) => r.id)).toEqual(sourceOrder.map((r) => r.id));
    const [{ x }] = await F.sql(url, 'SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x');
    expect(after.every((r) => BigInt(r.k) < BigInt(x))).toBe(true);
    expect(after.filter((r) => r.k === '0').map((r) => r.id)).toEqual(['evtzero1', 'evtzero2']);
    await expect(assertEventKeysLocal(pgQueryable(url))).resolves.toBeUndefined();

    const owners = await F.sql(
      url,
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m')`,
    );
    expect(owners).toEqual([{ o: F.ROLES.owner }]);
    const grantees = await F.sql(
      url,
      `SELECT DISTINCT a.grantee::regrole::text AS g FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              aclexplode(c.relacl) a WHERE n.nspname = 'public' ORDER BY 1`,
    );
    expect(grantees.map((r: any) => r.g).sort()).toEqual([F.ROLES.serve, F.ROLES.owner].sort());
    const cfg = await F.sql(
      B.url(),
      `SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = $1 AND s.setrole = 0`,
      [target],
    );
    expect(cfg[0].setconfig).toEqual(['work_mem=8MB']);
    const prov = await F.sql(url, `SELECT dump_sha256, stage, database_oid::int AS oid FROM hadron_restore.restore_provenance`);
    expect(prov).toEqual([{ dump_sha256: res.dumpSha256, stage: 'final', oid: res.oid }]);
    expect(await status(F.adminUrl(B), target)).toEqual({ status: 'RELEASED', oid: res.oid });
    expect(await tryConnect(B.url(target, F.ROLES.serve, F.PASSWORD))).toBe(true);
    expect(await tryConnect(B.url(target, F.ROLES.owner, F.PASSWORD))).toBe(true);
    expect(await tryConnect(B.url(target, F.ROLES.other, F.PASSWORD))).toBe(false);
  });

  it('R5: a rerun of the rebase on the released database writes nothing', async () => {
    const target = fresh();
    await restoreWithRebase(base({ target }));
    const before = await F.servingOrder(B.url(target));
    const c = new Client({ connectionString: B.url(target) });
    await c.connect();
    try {
      expect(await rebaseEventKeys(c)).toMatchObject({ state: 'local-only', updated: 0 });
    } finally {
      await c.end();
    }
    expect(await F.servingOrder(B.url(target))).toEqual(before);
  });

  it('P7: an older image without the key column restores; nothing to map', async () => {
    const target = fresh();
    const res = await restoreWithRebase(base({ target, dump: dumps.noKey }));
    expect(res.rebase).toEqual({ state: 'no-key-column' });
    expect(res.status).toBe('RELEASED');
  });

  it('P1: refusals before any create (existing target, missing settings, superuser, no SET membership, bad template)', async () => {
    const count = async () => Number((await F.sql(B.url(), 'SELECT count(*) AS n FROM pg_database'))[0].n);
    const start = await count();
    const existing = fresh();
    await F.sql(B.url(), `CREATE DATABASE ${existing}`);
    const refusals: [Partial<RunOptions>, RegExp][] = [
      [{ target: existing }, /already exists/],
      [{ dbSettings: null }, /database-level settings/],
      [{ adminUrl: B.url() }, /superuser/],
      [{ template: 'postgres' }, /IS_TEMPLATE/],
      [{ serveRole: F.ROLES.owner }, /serve role must not be the owner/],
      [{ serveRole: 'no_such_role' }, /does not exist/],
    ];
    for (const [over, msg] of refusals) {
      const err = await restoreWithRebase(base(over)).catch((e) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.stage).toBe('S0');
      expect(err.message).toMatch(msg);
    }
    await F.sql(B.url(), `CREATE ROLE nomember_admin LOGIN CREATEDB PASSWORD '${F.PASSWORD}'`);
    await F.sql(B.url(), `CREATE ROLE inherit_admin LOGIN CREATEDB PASSWORD '${F.PASSWORD}'`);
    await F.sql(B.url(), `GRANT ${F.ROLES.owner} TO inherit_admin WITH INHERIT TRUE, SET TRUE`);
    for (const admin of ['nomember_admin', 'inherit_admin']) {
      const err = await restoreWithRebase(base({ adminUrl: B.url('postgres', admin, F.PASSWORD) })).catch((e) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.message).toMatch(/INHERIT FALSE, SET TRUE/);
    }
    expect(await count()).toBe(start + 1);
  });

  it('P11: a dump extension the template lacks refuses at S0; every template extension is filtered out of the TOC', async () => {
    const err = await restoreWithRebase(base({ dump: dumps.extra })).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.stage).toBe('S0');
    expect(err.message).toMatch(/citext/);
    const toc = [
      '3; 3079 16385 EXTENSION - vector ',
      '4520; 0 0 COMMENT - EXTENSION vector ',
      '5; 1259 16390 TABLE public nodes owner',
    ].join('\n');
    expect([...tocExtensions(toc)]).toEqual(['vector']);
    expect(filterToc(toc, new Set(['vector'])).split('\n').filter((l) => !l.startsWith(';'))).toEqual([
      '5; 1259 16390 TABLE public nodes owner',
    ]);
  });

  it('P5: a failure at each stage before the release tears the target down by oid', async () => {
    for (const fault of ['S3', 'S4', 'final-verify', 'pre-release'] as const) {
      const target = fresh();
      const err = await restoreWithRebase(base({ target, fault })).catch((e) => e);
      expect(err, fault).toBeInstanceOf(RestoreError);
      expect(err.teardown, fault).toBe('dropped');
      expect(await dbExists(target), fault).toBe(false);
    }
  });

  it('R6/P5: more runs than the headroom refuses at S4 with zero writes, and tears down', async () => {
    const target = fresh();
    const err = await restoreWithRebase(base({ target, dump: dumps.manyRuns })).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.stage).toBe('S4');
    expect(err.message).toMatch(/needs 2\d{5} xids of headroom, cluster has \d+/);
    expect(err.teardown).toBe('dropped');
    expect(await dbExists(target)).toBe(false);
  });

  it('R6: K = C passes and K = C + 1 refuses with zero writes (rebase on the target cluster)', async () => {
    for (const extra of [0, 1]) {
      const db = fresh();
      await F.sql(B.url(), `CREATE DATABASE ${db} TEMPLATE ${F.TEMPLATE}`);
      await F.sql(
        B.url(db),
        `CREATE TABLE agent_team_events (id text PRIMARY KEY, created_at timestamp(3) NOT NULL, tx_id xid8 NOT NULL DEFAULT pg_current_xact_id())`,
      );
      await F.sql(
        B.url(db),
        `CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
         CREATE TRIGGER agent_team_event_append_only BEFORE UPDATE ON agent_team_events FOR EACH ROW EXECUTE FUNCTION noop()`,
      );
      // The insert takes xid Y = current xmax; afterwards xmax is Y + 1 on a quiet cluster, so C = Y - 2.
      const [{ y }] = await F.sql(B.url(db), 'SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS y');
      const k = Number(BigInt(y) - 2n) + extra;
      await F.sql(
        B.url(db),
        `INSERT INTO agent_team_events (id, created_at, tx_id)
         SELECT lpad(g::text, 6, '0'), now() - g * interval '1 second', (900000000 + g)::text::xid8 FROM generate_series(1, $1) g`,
        [k],
      );
      const before = await F.sql(B.url(db), 'SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id');
      const c = new Client({ connectionString: B.url(db) });
      await c.connect();
      try {
        const out = await rebaseEventKeys(c).catch((e) => e);
        if (extra === 0) {
          expect(out).toMatchObject({ state: 'rebased', runs: k, capacity: String(k) });
        } else {
          expect(out).toBeInstanceOf(RebaseHeadroomError);
          expect(await F.sql(B.url(db), 'SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id')).toEqual(before);
        }
      } finally {
        await c.end();
      }
    }
  });

  it('P2/P6: no role connects before the release statement, however often it tries; the serve role connects after', async () => {
    const target = fresh();
    const events: { at: number; what: string }[] = [];
    let releasingAt = Infinity;
    let stop = false;
    const hammer = (role: string) =>
      (async () => {
        while (!stop) {
          if (await tryConnect(B.url(target, role, F.PASSWORD))) events.push({ at: performance.now(), what: role });
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
    const loops = [F.ROLES.serve, F.ROLES.owner, F.ROLES.other].map(hammer);
    await restoreWithRebase(
      base({
        target,
        log: (e) => {
          if (e.event === 'releasing') releasingAt = performance.now();
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    stop = true;
    await Promise.all(loops);
    // 'releasing' is logged immediately before the release statement is sent: no connect may succeed before it.
    expect(releasingAt).toBeLessThan(Infinity);
    const early = events.filter((e) => e.at < releasingAt);
    expect(early).toEqual([]);
    expect(events.some((e) => e.what === F.ROLES.serve)).toBe(true);
    expect(events.some((e) => e.what === F.ROLES.other)).toBe(false);
  });

  it('P3: a foreign (superuser) session at the hard fence aborts; it is never killed, and the drop waits for it', async () => {
    const target = fresh();
    let intruder: Client | null = null;
    const err = await restoreWithRebase(
      base({
        target,
        log: (e) => {
          if (e.stage === 'S4' && e.event === 'rebased') {
            intruder = new Client({ connectionString: B.url(target) });
            return intruder.connect();
          }
        },
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.stage).toBe('final');
    expect(err.message).toMatch(/foreign session/);
    expect(err.teardown).toBe('drop-failed');
    expect(await dbExists(target)).toBe(true);
    await (intruder as Client | null)?.end();
    const [{ oid }] = await F.sql(B.url(), 'SELECT oid::int AS oid FROM pg_database WHERE datname = $1', [target]);
    expect(await teardown(F.adminUrl(B), target, oid, F.ROLES.owner)).toBe('dropped');
  });

  it('P10: a lost reply after the release statement resolves to RELEASED; teardown never drops a released target', async () => {
    const target = fresh();
    const res = await restoreWithRebase(base({ target, fault: 'release-reply' }));
    expect(res.status).toBe('RELEASED');
    expect(await status(F.adminUrl(B), target)).toEqual({ status: 'RELEASED', oid: res.oid });
    expect(await teardown(F.adminUrl(B), target, res.oid, F.ROLES.owner)).toBe('released-kept');
    expect(await dbExists(target)).toBe(true);
    expect(await teardown(F.adminUrl(B), 'renamed_elsewhere', res.oid, F.ROLES.owner)).toBe('name-mismatch');
    expect(await teardown(F.adminUrl(B), target, 4_000_000_000, F.ROLES.owner)).toBe('absent');
  });

  it('P9: a plain restore with foreign keys into a database fails the boot check, and the check writes nothing', async () => {
    const db = fresh();
    await F.sql(B.url(), `CREATE DATABASE ${db} TEMPLATE ${F.TEMPLATE}`);
    const { execFileSync } = await import('node:child_process');
    execFileSync(`${B.bin}/pg_restore`, ['--no-owner', '--no-privileges', '-d', B.url(db), dumps.full], { stdio: 'pipe' });
    const before = await F.servingOrder(B.url(db));
    const err = await assertEventKeysLocal(pgQueryable(B.url(db))).catch((e) => e);
    expect(err).toBeInstanceOf(ForeignEventKeyError);
    expect(await F.servingOrder(B.url(db))).toEqual(before);
  });

  // Gate-owner P9 ruling on #4116 (comment 6848664427): the WHOLE bootstrap writes nothing before the refusal, not only
  // the check. The real entry point, on a plain foreign-key restore with no rate metadata (which assertRateReadiness
  // would seed), against a whole-database image.
  const appTables = async (url: string) => {
    const tables = await F.sql<{ t: string }>(
      url,
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    const out: { t: string; n: number; h: string }[] = [];
    for (const { t } of tables) {
      const [row] = await F.sql<{ n: number; h: string }>(
        url,
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM public."${t}" x`,
      );
      out.push({ t, ...row });
    }
    return out;
  };
  const freePort = async () => {
    const { createServer } = await import('node:net');
    return new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
    });
  };
  /** Run src/index.ts as a development process; resolve on exit or on its listening line. */
  const boot = async (databaseUrl: string, port: number) => {
    const { spawn } = await import('node:child_process');
    const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: databaseUrl, PORT: String(port), MIGRATE_DATABASE_URL: '', BASE_URL: `http://127.0.0.1:${port}` };
    const child = spawn('node_modules/.bin/tsx', ['src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const result = await new Promise<{ code: number | null; listening: boolean }>((resolve) => {
      const timer = setTimeout(() => resolve({ code: null, listening: false }), 90_000);
      child.stdout.on('data', () => {
        if (out.includes('hadron-server listening')) {
          clearTimeout(timer);
          resolve({ code: null, listening: true });
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, listening: false });
      });
    });
    return { ...result, out: () => out, stop: () => child.kill('SIGKILL') };
  };

  it('P9 (ruling 6848664427): the real bootstrap refuses a plain foreign-key restore with zero database writes, no listener', async () => {
    const db = fresh();
    await F.sql(B.url(), `CREATE DATABASE ${db} TEMPLATE ${F.TEMPLATE}`);
    const { execFileSync } = await import('node:child_process');
    execFileSync(`${B.bin}/pg_restore`, ['--no-owner', '--no-privileges', '-d', B.url(db), dumps.full], { stdio: 'pipe' });
    await F.sql(B.url(db), 'TRUNCATE rate_limit_policies, rate_limit_manifests CASCADE');
    const before = await appTables(B.url(db));
    expect(before.find((r) => r.t === 'rate_limit_manifests')?.n).toBe(0);
    expect(before.find((r) => r.t === 'agent_team_events')?.n).toBeGreaterThan(0);
    expect(before.every((r) => typeof r.h === 'string' && r.h.length === 32)).toBe(true);
    const port = await freePort();
    const run = await boot(B.url(db), port);
    run.stop();
    expect(run.listening, run.out()).toBe(false);
    expect(run.code, run.out()).not.toBe(0);
    expect(run.out()).toMatch(/FOREIGN_EVENT_KEYS|logically restored without the key rebase/);
    expect(run.out()).not.toMatch(/hadron-server listening/);
    const { connect: tcp } = await import('node:net');
    const open = await new Promise<boolean>((resolve) => {
      const sock = tcp(port, '127.0.0.1');
      sock.on('connect', () => (sock.destroy(), resolve(true)));
      sock.on('error', () => resolve(false));
    });
    expect(open).toBe(false);
    expect(await appTables(B.url(db))).toEqual(before);
  });

  it('P9 positive: the pipeline output boots, and the ordinary readiness still seeds rate metadata', async () => {
    const target = fresh();
    await restoreWithRebase(base({ target }));
    await F.sql(B.url(target), 'TRUNCATE rate_limit_policies, rate_limit_manifests CASCADE');
    const port = await freePort();
    const run = await boot(B.url(target, F.ROLES.owner, F.PASSWORD), port);
    try {
      expect(run.listening, run.out()).toBe(true);
      const [{ n }] = await F.sql(B.url(target), 'SELECT count(*)::int AS n FROM rate_limit_manifests');
      expect(n).toBeGreaterThan(0);
    } finally {
      run.stop();
    }
  });

  it('P12: the owner-only statements fail for restore_admin without SET ROLE', async () => {
    const target = fresh();
    await restoreWithRebase(base({ target }));
    const c = new Client({ connectionString: F.adminUrl(B) });
    await c.connect();
    try {
      await expect(c.query(`ALTER DATABASE ${target} ALLOW_CONNECTIONS false`)).rejects.toThrow(/must be owner/);
      await expect(c.query(`ALTER DATABASE ${target} CONNECTION LIMIT 1`)).rejects.toThrow(/must be owner/);
      await expect(c.query(`DROP DATABASE ${target}`)).rejects.toThrow(/must be owner/);
      const before = await F.sql(B.url(), 'SELECT datacl::text AS a FROM pg_database WHERE datname = $1', [target]);
      await c.query(`GRANT CONNECT ON DATABASE ${target} TO ${F.ROLES.other}`).catch(() => undefined);
      expect(await F.sql(B.url(), 'SELECT datacl::text AS a FROM pg_database WHERE datname = $1', [target])).toEqual(before);
    } finally {
      await c.end();
    }
  });
  it('T4: the serve role cannot disable the append-only trigger, by name, by ALL, or by session_replication_role', async () => {
    const target = fresh();
    await restoreWithRebase(base({ target }));
    const triggers = () =>
      F.sql(B.url(target), `SELECT tgname::text AS n, tgenabled::text AS e FROM pg_trigger WHERE tgrelid = 'agent_team_events'::regclass ORDER BY 1`);
    const start = await triggers();
    const c = new Client({ connectionString: B.url(target, F.ROLES.serve, F.PASSWORD) });
    await c.connect();
    try {
      await expect(c.query('ALTER TABLE agent_team_events DISABLE TRIGGER agent_team_event_append_only')).rejects.toThrow(
        /must be owner/,
      );
      await expect(c.query('ALTER TABLE agent_team_events DISABLE TRIGGER ALL')).rejects.toThrow(/must be owner/);
      await expect(c.query('SET session_replication_role = replica')).rejects.toThrow(/permission denied/);
      // Through the helper, inside a writer-excluding transaction the serve role can take: still refused at the ALTER.
      await c.query('BEGIN');
      await c.query('LOCK TABLE agent_team_events IN EXCLUSIVE MODE');
      await expect(withAppendOnlyTriggerOff(c, async () => undefined)).rejects.toThrow(/must be owner/);
      await c.query('ROLLBACK');
      await expect(c.query(`UPDATE agent_team_events SET tx_id = '3' WHERE tx_id <> '3'`)).rejects.toThrow(/append-only/);
    } finally {
      await c.end();
    }
    expect(await triggers()).toEqual(start);
    expect(start).toContainEqual({ n: 'agent_team_event_append_only', e: 'O' });
  });

  // Rook's P3-1 on #4116: the two S2 fence checks, pinned.
  it('S2: a login role that inherits restore_admin can still connect, so the ACL fence refuses and tears down', async () => {
    await F.sql(B.url(), `CREATE ROLE inherits_admin LOGIN PASSWORD '${F.PASSWORD}' IN ROLE ${F.ROLES.admin}`);
    try {
      const target = fresh();
      const err = await restoreWithRebase(base({ target })).catch((e) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.stage).toBe('S2');
      expect(err.message).toMatch(/ACL fence: inherits_admin can still connect/);
      expect(err.teardown).toBe('dropped');
      expect(await dbExists(target)).toBe(false);
    } finally {
      await F.sql(B.url(), 'DROP ROLE inherits_admin');
    }
  });

  it('S2: a session connected before admission refuses; it is never killed, so the drop waits for it', async () => {
    const target = fresh();
    let early: Client | null = null;
    const err = await restoreWithRebase(
      base({
        target,
        log: async (e) => {
          if (e.stage === 'S1' && e.event === 'created') {
            await F.sql(B.url(), `ALTER DATABASE ${target} ALLOW_CONNECTIONS true`);
            early = new Client({ connectionString: B.url(target) });
            await early.connect();
          }
        },
      }),
    ).catch((e) => e);
    try {
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.stage).toBe('S2');
      expect(err.message).toMatch(/a session is connected before admission/);
      expect(err.teardown).toBe('drop-failed');
      expect(await dbExists(target)).toBe(true);
    } finally {
      await (early as Client | null)?.end();
    }
    expect(await teardown(F.adminUrl(B), target, err.oid, F.ROLES.owner)).toBe('dropped');
  });

  // Rook's P3-2 on #4116: three S0 refusals, pinned; nothing is created.
  it('S0: CREATEROLE on restore_admin, a superuser connect role and a non-quiescent template each refuse', async () => {
    const t1 = fresh();
    await F.sql(B.url(), `ALTER ROLE ${F.ROLES.admin} CREATEROLE`);
    try {
      await expect(restoreWithRebase(base({ target: t1 }))).rejects.toThrow(/\[S0\].*has CREATEROLE/);
    } finally {
      await F.sql(B.url(), `ALTER ROLE ${F.ROLES.admin} NOCREATEROLE`);
    }
    const t2 = fresh();
    await expect(restoreWithRebase(base({ target: t2, connectRoles: ['postgres'] }))).rejects.toThrow(/\[S0\] role postgres is a superuser/);
    const t3 = fresh();
    const holder = new Client({ connectionString: B.url(F.TEMPLATE) });
    await holder.connect();
    try {
      await expect(restoreWithRebase(base({ target: t3 }))).rejects.toThrow(/\[S0\] template .* is not quiescent/);
    } finally {
      await holder.end();
    }
    for (const t of [t1, t2, t3]) expect(await dbExists(t)).toBe(false);
  });

  // Blind finding F1 on #4116: an error from CREATE DATABASE does not prove nothing was created.
  it('F1: the CREATE commits and the session dies before the oid is read: re-read from a fresh connection, torn down', async () => {
    const target = fresh();
    const events: Record<string, unknown>[] = [];
    const err = await restoreWithRebase(base({ target, fault: 'S1-reply', log: (e) => void events.push(e) })).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.stage).toBe('S1');
    expect(err.teardown).toBe('dropped');
    expect(err.oid).toEqual(expect.any(Number));
    expect(err.message).toMatch(/terminat|connection/i);
    expect(await dbExists(target)).toBe(false);
    expect(events.some((e) => e.event === 'created')).toBe(false);
  });

  it('F1: a same-named database another role made before the CREATE is reported as uncertain and never dropped', async () => {
    const target = fresh();
    const err = await restoreWithRebase(
      base({
        target,
        // After S0 saw the name free, before S1's CREATE: a superuser makes the name, owned by someone else.
        log: async (e) => {
          if (e.stage === 'S0' && e.event === 'ok') await F.sql(B.url(), `CREATE DATABASE ${target}`);
        },
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.stage).toBe('S1');
    expect(err.teardown).toBe('uncertain');
    expect(err.message).toMatch(/already exists.*not provably this run's/s);
    expect(await dbExists(target)).toBe(true);
    await F.sql(B.url(), `DROP DATABASE ${target}`);
  });

  it('F1: a same-shaped database made by the owner itself before the window opens is still not taken for this run', async () => {
    // Same owner, admission off, the working limit, default ACL: only the creating xid tells it apart.
    const target = fresh();
    await F.sql(B.url(), `CREATE DATABASE ${target} OWNER ${F.ROLES.owner} TEMPLATE ${F.TEMPLATE} ALLOW_CONNECTIONS false CONNECTION LIMIT 4`);
    const { reconcileCreate } = await import('./restore-with-rebase.js');
    const [{ x }] = await F.sql(B.url(), 'SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x');
    expect(await reconcileCreate(F.adminUrl(B), target, F.ROLES.owner, x)).toEqual({ oid: expect.any(Number), mine: false });
    expect(await reconcileCreate(F.adminUrl(B), `${target}_absent`, F.ROLES.owner, x)).toBe('absent');
    await F.sql(B.url(), `DROP DATABASE ${target}`);
  });

  // Andi's LOCAL F1 on #4116: an inherited PGSERVICE redirected pg_restore into another cluster while every other step
  // used RESTORE_ADMIN_URL. The child's environment now comes from the URL alone.
  it('LOCAL F1: an inherited PGSERVICE pointing at another cluster cannot redirect pg_restore', async () => {
    const target = fresh();
    // The decoy: the same database name on cluster A, empty, writable by a trusted superuser the service selects.
    await F.sql(A.url(), `CREATE DATABASE ${target}`);
    const { writeFileSync } = await import('node:fs');
    const svc = `${A.dir}/pg_service.conf`;
    writeFileSync(svc, `[decoy]\nhost=127.0.0.1\nport=${A.port}\nuser=postgres\ndbname=${target}\n`);
    const saved = { s: process.env.PGSERVICE, f: process.env.PGSERVICEFILE };
    process.env.PGSERVICE = 'decoy';
    process.env.PGSERVICEFILE = svc;
    try {
      const res = await restoreWithRebase(base({ target }));
      expect(res.status).toBe('RELEASED');
    } finally {
      if (saved.s === undefined) delete process.env.PGSERVICE;
      else process.env.PGSERVICE = saved.s;
      if (saved.f === undefined) delete process.env.PGSERVICEFILE;
      else process.env.PGSERVICEFILE = saved.f;
    }
    expect((await F.servingOrder(B.url(target))).map((r) => r.id)).toEqual(sourceOrder.map((r) => r.id));
    const [{ n }] = await F.sql(A.url(target), `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public'`);
    expect(n).toBe(0);
    await F.sql(A.url(), `DROP DATABASE ${target}`);
  });

  // Blind finding F2 on #4116: pg_restore gets the same TLS settings as the pipeline's own sessions.
  it('F2: a restore whose admin connection needs a client certificate succeeds end to end (pg_restore included)', async () => {
    const tlsRole = 'restore_tls';
    await F.sql(B.url(), `CREATE ROLE ${tlsRole} LOGIN CREATEDB`);
    await F.sql(B.url(), `GRANT ${F.ROLES.owner} TO ${tlsRole} WITH INHERIT FALSE, SET TRUE`);
    const files = B.enableTls(tlsRole);
    const url =
      `postgresql://${tlsRole}@127.0.0.1:${B.port}/postgres?sslmode=verify-full` +
      `&sslrootcert=${encodeURIComponent(files.ca)}&sslcert=${encodeURIComponent(files.cert)}&sslkey=${encodeURIComponent(files.key)}`;
    // The reload is asynchronous: wait until the certificate rule answers.
    const { status: st } = await import('./restore-with-rebase.js');
    for (let i = 0; ; i++) {
      try {
        await st(url, 'postgres');
        break;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Without the certificate the role cannot connect at all, so pg_restore must have used it.
    expect(await tryConnect(`postgresql://${tlsRole}@127.0.0.1:${B.port}/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(files.ca)}`)).toBe(false);
    expect(await tryConnect(`postgresql://${tlsRole}@127.0.0.1:${B.port}/postgres`)).toBe(false);
    const target = fresh();
    const res = await restoreWithRebase(base({ adminUrl: url, target }));
    expect(res.status).toBe('RELEASED');
    expect((await F.servingOrder(B.url(target))).map((r) => r.id)).toEqual(sourceOrder.map((r) => r.id));
    const sessions = await F.sql(B.url(), `SELECT count(*)::int AS n FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename = $1 AND NOT s.ssl`, [tlsRole]);
    expect(sessions[0].n).toBe(0);
  });
});
