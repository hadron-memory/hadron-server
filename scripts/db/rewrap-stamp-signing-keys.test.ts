/**
 * #2973 C1 — the rewrap TOOL's own contract (Bob P2-C / P3-1, delta reviews of 77c9fda85b and deef730133; Xylon
 * #93367: protected root input, actual-tool tests): the roots never travel on argv (world-readable through ps and
 * /proc/<pid>/cmdline, and this root decrypts every token the platform stores) — they come from mode-0600 files or
 * protected stdin; the before/after verification is real (SHA-256 commitments compared, not a self-referential
 * probe); and no log line ever echoes a root or key material. Drives the real `main` against the worker DB with the
 * real filesystem for the root files (the `RewrapToolIo` seam exists for stdin and env, which a vitest worker
 * cannot offer honestly).
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { encryptBytesAad } from '../../src/lib/tokenCrypto.js';
import { mintStampSigningKey, stampKeyAad, stampVerificationKey } from '../../src/lib/signing/stampKeys.js';
import { main, type RewrapToolIo } from './rewrap-stamp-signing-keys.js';

const ROOT_A = '0'.repeat(64); // what vitest.config.ts pins as HADRON_ENCRYPTION_KEY
const ROOT_B = 'b'.repeat(64);

const mint = () => db.$transaction((tx) => mintStampSigningKey(tx));

let lines: string[] = [];
let paths: string[] = [];

/** The real fs (mode and content) for root files; only stdin and env are faked, which a worker cannot own. */
const io = (over: Partial<RewrapToolIo> = {}): RewrapToolIo => ({
  env: process.env,
  log: (line) => lines.push(line),
  readStdin: async () => '',
  statMode: async (path) => (await stat(path)).mode,
  readFileText: async (path) => await readFile(path, 'utf8'),
  ...over,
});

/** A root file on the real filesystem, mode `mode`. */
async function rootFile(hex: string, mode: number): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'rewrap-tool-test-')), 'root');
  await writeFile(path, `${hex}\n`, { mode: 0o600 });
  await chmod(path, mode);
  paths.push(path);
  return path;
}
const rootPair = (mode = 0o600) => Promise.all([rootFile(ROOT_A, mode), rootFile(ROOT_B, mode)]);

beforeEach(async () => {
  await cleanDb(db);
  process.env.HADRON_ENCRYPTION_KEY = ROOT_A;
  lines = [];
});
afterEach(async () => {
  await Promise.allSettled(paths.map((p) => rm(join(p, '..'), { recursive: true, force: true })));
  paths = [];
  process.env.HADRON_ENCRYPTION_KEY = ROOT_A;
});

describe('#2973 rewrap tool — root input (Bob P2-C: never argv)', () => {
  it('two bare hex arguments are refused as usage, whatever their shape', async () => {
    expect(await main([ROOT_A, ROOT_B], io())).toBe(2);
    expect(lines.some((l) => l.includes('never argv') || l.includes('roots are never argv'))).toBe(true);
    expect(await db.stampSigningKey.count()).toBe(0); // nothing ran
  });

  it('a root file looser than 0600 is refused before anything runs', async () => {
    await mint();
    const material = (await db.stampSigningKey.findFirstOrThrow()).keyMaterial;
    const [from, to] = await rootPair(0o644);
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(2);
    expect(lines.some((l) => l.includes('refused_file_mode'))).toBe(true);
    expect((await db.stampSigningKey.findFirstOrThrow()).keyMaterial).toBe(material); // nothing ran
  });

  it('one file flag without the other is usage', async () => {
    const from = await rootFile(ROOT_A, 0o600);
    expect(await main(['--from-root-file', from], io())).toBe(2);
  });

  it('a root file that is not 64 hex characters is usage', async () => {
    const bad = await rootFile('not-hex-at-all', 0o600);
    const to = await rootFile(ROOT_B, 0o600);
    expect(await main(['--from-root-file', bad, '--to-root-file', to], io())).toBe(2);
    expect(lines.some((l) => l.includes('64 hex'))).toBe(true);
  });

  it('stdin with fewer than two lines is usage', async () => {
    expect(await main([], io({ readStdin: async () => `${ROOT_A}\n` }))).toBe(2);
  });

  it('no DATABASE_URL is usage, before any client is built', async () => {
    expect(await main([], io({ env: {}, readStdin: async () => `${ROOT_A}\n${ROOT_B}\n` }))).toBe(2);
    expect(lines.some((l) => l.includes('database_url_missing'))).toBe(true);
  });
});

describe('#2973 rewrap tool — the run (atomic, idempotent, verified; Bob P3-1)', () => {
  it('rewraps via 0600 files, exits 0, and a re-run is a no-op; the stdin path runs too', async () => {
    const { id } = await mint();
    const origKey = await stampVerificationKey(db, id); // env is ROOT_A here
    expect(origKey).not.toBeNull();
    const materialBefore = (await db.stampSigningKey.findFirstOrThrow()).keyMaterial;

    const [from, to] = await rootPair();
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(0);
    expect(lines.some((l) => l.includes('ok rows=1 rewrapped=1 verified=1'))).toBe(true);
    const materialAfter = (await db.stampSigningKey.findFirstOrThrow()).keyMaterial;
    expect(materialAfter).not.toBe(materialBefore);

    // Idempotent: rows already under the new root are skipped, same exit 0.
    lines = [];
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(0);
    expect(lines.some((l) => l.includes('ok rows=1 rewrapped=0 verified=1'))).toBe(true);

    // The stdin path (from first, then to) rolls the registry back to ROOT_A. GCM re-encryption yields fresh
    // ciphertext, so identity is at the KEY level, not the bytes level: the unwrapped key is the original again.
    lines = [];
    expect(await main([], io({ readStdin: async () => `${ROOT_B}\n${ROOT_A}\n` }))).toBe(0);
    expect(await stampVerificationKey(db, id)).not.toBeNull();
    expect((await stampVerificationKey(db, id))!.equals(origKey!)).toBe(true);
  });

  it('a planted row that unwraps under neither root fails verification and exits 1', async () => {
    const { id } = await mint();
    // Honest AAD, but wrapped under a THIRD root — ciphertext neither the from-root nor the to-root can open,
    // the seed-proof shape an attacker plants (a row wrapped under either explicit root unwraps fine by design).
    const ROOT_C = 'c'.repeat(64);
    process.env.HADRON_ENCRYPTION_KEY = ROOT_C;
    try {
      await db.stampSigningKey.create({
        data: { id: id + 1, keyMaterial: encryptBytesAad(Buffer.alloc(32, 9), stampKeyAad(id + 1)) },
      });
    } finally {
      process.env.HADRON_ENCRYPTION_KEY = ROOT_A;
    }
    const [from, to] = await rootPair();
    expect(await main(['--from-root-file', from, '--to-root-file', to], io())).toBe(1);
    expect(lines.some((l) => l.includes('verify_failed') || l.includes('unwraps under neither root'))).toBe(true);
  });
});

describe('#2973 rewrap tool — disclosure', () => {
  it('no log line ever contains a root or unwrapped key material', async () => {
    await mint();
    const [from, to] = await rootPair();
    await main(['--from-root-file', from, '--to-root-file', to], io());
    const secret = Buffer.from((await db.stampSigningKey.findFirstOrThrow()).keyMaterial, 'base64').toString('hex');
    for (const line of lines) {
      expect(line).not.toContain(ROOT_A);
      expect(line).not.toContain(ROOT_B);
      expect(line).not.toContain(secret);
    }
  });
});
