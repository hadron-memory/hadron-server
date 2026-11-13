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
});
