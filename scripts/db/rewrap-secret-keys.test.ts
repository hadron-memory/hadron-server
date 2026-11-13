/**
 * #4003 (S8 of #3991; R18) — the secrets-root re-wrap TOOL's contract, modelled on the stamp-key tool (#2973):
 * roots never on argv (mode-0600 files or piped stdin only), the run is atomic and idempotent, verification
 * unwraps every row under the NEW root only (a re-wrap that wrote nothing exits 1), and no log line echoes a root.
 */
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { decryptBytesAad, encryptBytesAad } from '../../src/lib/tokenCrypto.js';
import { appKeyAad, appKeyCache, ensureAppKey, unwrapAppKey } from '../../src/lib/secrets/appKeys.js';
import { main, type SecretRewrapToolIo } from './rewrap-secret-keys.js';

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

  it('a planted row under a third root exits 1 and leaves every row as it was', async () => {
    await mint();
    const before = await wrapped();
    const other = (await createDbAppWithKey(db, 'rewrap-other', orgId)).app.id;
    await db.secretAppKey.create({
      data: { appId: other, keyVersion: 1, wrappedKey: encryptBytesAad(Buffer.alloc(32, 9), appKeyAad(other, 1), Buffer.from('e5'.repeat(32), 'hex')) },
    });
    const [from, to] = await rootPair();
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(1);
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
