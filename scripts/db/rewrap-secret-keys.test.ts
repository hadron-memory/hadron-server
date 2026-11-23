/**
 * #4003 (S8 of #3991; R18) — the secrets-root re-wrap TOOL's contract, modelled on the stamp-key tool (#2973):
 * roots never on argv (mode-0600 files or piped stdin only), the run is atomic and idempotent, verification
 * unwraps every row under the NEW root only (a re-wrap that wrote nothing exits 1), and no log line echoes a root.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, escapeIdentifier } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { decryptBytesAad, encryptBytesAad } from '../../src/lib/tokenCrypto.js';
import { appKeyAad, appKeyCache, ensureAppKey, lockAppKeyMint, rootCheckValue, unwrapAppKey } from '../../src/lib/secrets/appKeys.js';
import { main, type SecretRewrapToolIo } from './rewrap-secret-keys.js';

/** #4553 §10 F3 (G4): a library re-wrap that reports success but wrote nothing, so the tool's own AFTER check is tested. */
const fake = vi.hoisted(() => ({ silentRewrap: false, skipBefore: false }));
vi.mock('../../src/lib/secrets/rotation.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/secrets/rotation.js')>();
  return {
    ...real,
    rewrapSecretRootKeys: (...args: Parameters<typeof real.rewrapSecretRootKeys>) =>
      fake.silentRewrap
        // It still takes the BEFORE pass in a transaction (without the lock: nothing contends here); only the writes are missing.
        ? args[0].$transaction(async (tx) => { await args[3]?.(tx); return { rows: 1, rewrapped: 1 }; })
        : real.rewrapSecretRootKeys(args[0], args[1], args[2], fake.skipBefore ? undefined : args[3]),
  };
});

const ROOT_A = 'a1'.repeat(32);
const ROOT_B = 'b2'.repeat(32);
let appId: string;
let orgId: string;
let lines: string[] = [];
let paths: string[] = [];

const io = (over: Partial<SecretRewrapToolIo> = {}): SecretRewrapToolIo => ({
  env: process.env,
  log: (line) => lines.push(line),
  stdinIsTty: () => false,
  readStdin: async () => '',
  openRootFile: async (path) => {
    const fh = await open(path, 'r');
    try {
      const { mode } = await fh.stat();
      return { mode, text: await readFile(fh, 'utf8') };
    } finally {
      await fh.close();
    }
  },
  ...over,
});

async function rootFile(hex: string, mode: number): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'secret-rewrap-test-')), 'root');
  await writeFile(path, `${hex}\n`, { mode: 0o600 });
  await chmod(path, mode);
  paths.push(path);
  return path;
}
const rootPair = (mode = 0o600) => Promise.all([rootFile(ROOT_A, mode), rootFile(ROOT_B, mode)]);
const mint = () => db.$transaction((tx) => ensureAppKey(tx, appId));
const wrapped = async () => (await db.secretAppKey.findFirstOrThrow({ where: { appId } })).wrappedKey;

beforeEach(async () => {
  await cleanDb(db);
  process.env.SECRET_ROOT_KEY = ROOT_A;
  appKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'rewrap org', urn: 'rewrap-org.test' } });
  orgId = org.id;
  appId = (await createDbAppWithKey(db, 'rewrap-app', orgId)).app.id;
  lines = [];
});
afterEach(async () => {
  fake.silentRewrap = false;
  fake.skipBefore = false;
  await Promise.allSettled(paths.map((p) => rm(join(p, '..'), { recursive: true, force: true })));
  paths = [];
  delete process.env.SECRET_ROOT_KEY;
  appKeyCache.clear();
});

describe('secrets-root re-wrap tool: root input (never argv)', () => {
  it.each([
    [[ROOT_A, ROOT_B]],
    [['--from-root', ROOT_A, '--to-root', ROOT_B]],
    [[`--from-root=${ROOT_A}`]],
  ])('refuses roots on the command line (%j) before anything runs', async (argv) => {
    await mint();
    const before = await wrapped();
    expect(await main(argv, io())).toBe(2);
    expect(lines.some((l) => l.includes('never argv'))).toBe(true);
    expect(await wrapped()).toBe(before);
    for (const line of lines) {
      expect(line).not.toContain(ROOT_A);
      expect(line).not.toContain(ROOT_B);
    }
  });

  it('a root file looser than 0600 is refused before anything runs', async () => {
    await mint();
    const before = await wrapped();
    const [from, to] = await rootPair(0o644);
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(2);
    expect(lines.some((l) => l.includes('refused_file_mode'))).toBe(true);
    expect(await wrapped()).toBe(before);
  });

  it('one file flag without the other is usage', async () => {
    expect(await main(['--from-root-file', await rootFile(ROOT_A, 0o600)], io())).toBe(2);
  });

  it('stdin that is a terminal is refused (the roots would echo)', async () => {
    expect(await main([], io({ stdinIsTty: () => true, readStdin: async () => `${ROOT_A}\n${ROOT_B}\n` }))).toBe(2);
  });

  it('a third stdin line is usage, and nothing runs (#4573)', async () => {
    await mint();
    const before = await wrapped();
    expect(await main([], io({ readStdin: async () => `${ROOT_A}\n${ROOT_B}\n${'c3'.repeat(32)}\n` }))).toBe(2);
    expect(lines.some((l) => l.includes('exactly two root lines'))).toBe(true);
    expect(await wrapped()).toBe(before);
    expect(lines.join('\n')).not.toContain('c3c3');
  });

  it('two stdin lines, blank lines ignored, still run (#4573)', async () => {
    await mint();
    expect(await main([], io({ readStdin: async () => `\n${ROOT_A}\n\n${ROOT_B}\n\n` }))).toBe(0);
  });

  it('no DATABASE_URL is usage', async () => {
    expect(await main([], io({ env: {}, readStdin: async () => `${ROOT_A}\n${ROOT_B}\n` }))).toBe(2);
  });
});

describe('secrets-root re-wrap tool: the run', () => {
  it('re-wraps, verifies under the new root only, exits 0; a re-run is a no-op', async () => {
    const orig = await mint();
    const [from, to] = await rootPair();
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(0);
    expect(lines.some((l) => /ok .*rows=1 .*rewrapped=1 .*verified=1/.test(l))).toBe(true);
    const after = await wrapped();
    expect(() => decryptBytesAad(after, appKeyAad(appId, 1), Buffer.from(ROOT_A, 'hex'))).toThrow();
    process.env.SECRET_ROOT_KEY = ROOT_B;
    appKeyCache.clear();
    expect((await db.$transaction((tx) => unwrapAppKey(tx, appId, 1))).encryptionKey.equals(orig.encryptionKey)).toBe(true);

    lines = [];
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(0);
    expect(lines.some((l) => /rewrapped=0/.test(l))).toBe(true);
  });

  it('the AFTER check reads the NEW root only: a re-wrap that left a row under the old root exits 1 (#4553 G4)', async () => {
    await mint();
    const before = await wrapped();
    const [from, to] = await rootPair();
    fake.silentRewrap = true;
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(1);
    expect(lines.some((l) => l.includes('does not unwrap under the NEW root'))).toBe(true);
    expect(await wrapped()).toBe(before);
  });

  it('a run that wrote nothing on a store with no App keys exits 1: the recorded root check is read back (#4573)', async () => {
    await mint();
    await db.secretAppKey.deleteMany();
    const [from, to] = await rootPair();
    fake.silentRewrap = true;
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(1);
    expect(lines.some((l) => l.includes('verify_failed') && l.includes('root check'))).toBe(true);
    expect((await db.secretRootCheck.findUniqueOrThrow({ where: { id: 1 } })).checkValue).toBe(rootCheckValue(Buffer.from(ROOT_A, 'hex')));
  });

  it('a successful run leaves the root check naming the new root, even with no App keys (#4573)', async () => {
    const [from, to] = await rootPair();
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(0);
    expect((await db.secretRootCheck.findUniqueOrThrow({ where: { id: 1 } })).checkValue).toBe(rootCheckValue(Buffer.from(ROOT_B, 'hex')));
  });

  it('a key minted while the run waits for the root lock is in the BEFORE pass, so the run still verifies (#4573)', async () => {
    await mint();
    const other = (await createDbAppWithKey(db, 'rewrap-late', orgId)).app.id;
    const [from, to] = await rootPair();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedSignal = new Promise<void>((r) => { locked = r; });
    const minter = db.$transaction(async (tx) => {
      await lockAppKeyMint(tx, other);
      locked();
      await held;
      await ensureAppKey(tx, other);
    }, { timeout: 20_000 });
    await lockedSignal;
    const run = main(['--from-root-file', from, '--to-root-file', to], io());
    // The run is past its first statement once it waits, ungranted, for the exclusive root lock in this database.
    await vi.waitFor(async () => {
      const waiting = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      expect(waiting[0].n).toBe(1);
    }, { timeout: 10_000, interval: 50 });
    release();
    await minter;
    expect(await run, lines.join('\n')).toBe(0);
    expect(lines.some((l) => /rows=2 rewrapped=2 verified=2/.test(l))).toBe(true);
  });

  it('a re-wrap that never took the BEFORE pass is not verified: exit 1 (#4573)', async () => {
    await mint();
    const [from, to] = await rootPair();
    fake.skipBefore = true;
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(1);
    expect(lines.some((l) => l.includes('before=not taken'))).toBe(true);
  });

  it('--from equal to --to is usage, and nothing runs (#4553 F3)', async () => {
    await mint();
    const before = await wrapped();
    const same = await rootFile(ROOT_A, 0o600);
    expect(await main(['--from-root-file', same, '--to-root-file', same], io())).toBe(2);
    expect(await wrapped()).toBe(before);
  });

  it('the same root in another letter case is the same root: usage (#4553 N7)', async () => {
    await mint();
    const before = await wrapped();
    const lower = await rootFile('ab'.repeat(32), 0o600);
    const upper = await rootFile('AB'.repeat(32), 0o600);
    expect(await main(['--from-root-file', lower, '--to-root-file', upper], io())).toBe(2);
    expect(lines.some((l) => l.includes('the two roots are the same'))).toBe(true);
    expect(await wrapped()).toBe(before);
  });

  it('a planted row under a third root exits 1 and leaves every row as it was', async () => {
    await mint();
    const before = await wrapped();
    const other = (await createDbAppWithKey(db, 'rewrap-other', orgId)).app.id;
    await db.secretAppKey.create({
      data: { appId: other, keyVersion: 1, wrappedKey: encryptBytesAad(Buffer.alloc(32, 9), appKeyAad(other, 1), Buffer.from('e5'.repeat(32), 'hex')) },
    });
    const [from, to] = await rootPair();
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(1);
    // The BEFORE pass stopped the run: one line, naming the row, and the re-wrap's own refusal never ran (#4573).
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('unwraps under neither root');
    expect(await wrapped()).toBe(before);
  });

  it('no log line contains a root or a wrapped key', async () => {
    await mint();
    const [from, to] = await rootPair();
    await main(['--from-root-file', from, '--to-root-file', to], io());
    const w = await wrapped();
    for (const line of lines) {
      expect(line).not.toContain(ROOT_A);
      expect(line).not.toContain(ROOT_B);
      expect(line).not.toContain(w);
    }
  });
});

describe('secrets-root re-wrap tool: the credential (#4573)', () => {
  it('the serve role is refused by name, exits 1, and changes nothing: keys, root check, and no URL or password in the log', async () => {
    await mint();
    const before = await wrapped();
    const role = `rewrap_serve_${randomBytes(5).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN NOSUPERUSER PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${escapeIdentifier(role)}`);
      // What runtime-role.sql leaves the serve role on the two tables the re-wrap touches.
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.secret_app_keys TO ${escapeIdentifier(role)}`);
      await admin.query(`GRANT SELECT, INSERT ON public.secret_root_check TO ${escapeIdentifier(role)}`);
      const url = new URL(process.env.DATABASE_URL!);
      url.username = role;
      url.password = password;
      const [from, to] = await rootPair();
      expect(await main(['--from-root-file', from, '--to-root-file', to], io({ env: { DATABASE_URL: url.toString() } }))).toBe(1);
      expect(lines).toEqual([expect.stringMatching(/refused_not_owner: .*MIGRATE_DATABASE_URL/)]);
      expect(lines.join('\n')).not.toContain(password);
      expect(lines.join('\n')).not.toContain('postgresql:');
      expect(await wrapped()).toBe(before);
      expect((await db.secretRootCheck.findUniqueOrThrow({ where: { id: 1 } })).checkValue).toBe(rootCheckValue(Buffer.from(ROOT_A, 'hex')));

      // With both set, as in the container, the owner credential wins over the serve one the server runs with.
      lines = [];
      expect(await main(['--from-root-file', from, '--to-root-file', to],
        io({ env: { DATABASE_URL: url.toString(), MIGRATE_DATABASE_URL: process.env.DATABASE_URL } })), lines.join('\n')).toBe(0);
    } finally {
      await admin.query(`DROP OWNED BY ${escapeIdentifier(role)}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      await admin.end();
    }
  });
});
