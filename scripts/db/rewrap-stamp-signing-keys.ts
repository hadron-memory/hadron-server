/**
 * #2973 C1 — root-rotation re-wrap of the stamp-key registry (`stamp_signing_keys`), the tool the
 * HADRON_ENCRYPTION_KEY rotation runbook calls BEFORE switching the configured root (Bob P2-3/P2-C,
 * delta reviews of 77c9fda85b and deef730133).
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/rewrap-stamp-signing-keys.ts \
 *       --from-root-file /run/secrets/stamp-rewrap-from --to-root-file /run/secrets/stamp-rewrap-to
 *   # or, with no flags, two root lines on stdin (from first, then to):
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/rewrap-stamp-signing-keys.ts < roots.txt
 *
 * The roots NEVER appear on the command line (Bob P2-C: argv is world-readable through ps and
 * /proc/<pid>/cmdline, and it lands in shell history — and this root decrypts every token the
 * platform stores). They are read from mode-0600 files (a looser mode is refused) or protected
 * stdin, validated as 64 hex characters, and never logged or echoed. The runbook — the stopped-
 * writer sequence, the verification event, the rollback, and the WHOLE-ROOT boundary (this tool
 * rewraps ONLY the stamp registry; every other encrypted column is untouched, and the secret-store
 * switch must not run in production outside a whole-root rotation plan, none of which exists yet) —
 * lives in the ops node hrn:node:hadronmemory.com:dev:ops:alpha:stamp-key-registry-rotation.
 *
 * The whole rewrap is one transaction inside {@link rewrapStampSigningKeys} — atomic, idempotent,
 * and serialized against an in-flight creation (mint's leg) by the same advisory lock; a mint by a
 * still-running old-root instance AFTER the rewrap can still strand a row, so writers are stopped
 * and the post-switch re-run is the proof (Rico, delta review of f44e2c6a). The inverse argument
 * order is the rollback.
 *
 * Verification is real, not self-referential (Bob P3-1): BEFORE the rewrap every row is unwrapped
 * (under the old root, or the new one for an idempotent re-run) and SHA-256-committed; AFTER it
 * every row is unwrapped again and the commitments compared — same rows, same key bytes, so stamps
 * really do verify identically before and after. The digests are compared in memory and never
 * printed. A row that appears or vanishes between the two reads (a first mint racing the tool)
 * fails verification safely: exit 1, and the idempotent re-run settles it.
 *
 * Exit codes: 0 ok, 1 failed (rewrap or verify), 2 usage (bad input, open file mode, no DATABASE_URL).
 */
import { createHash } from 'crypto';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { rewrapStampSigningKeys, StampRegistryUnavailableError, stampKeyAad } from '../../src/lib/signing/stampKeys.js';
import { decryptBytesAad, encryptionKeyFromHex } from '../../src/lib/tokenCrypto.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Everything {@link main} touches outside its own logic, injectable so the tests drive the real
 * exit codes without a terminal, a filesystem, or a live stdin.
 */
export interface RewrapToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  readStdin: () => Promise<string>;
  /** True when stdin is an interactive terminal (Rico, delta review of f44e2c6a): reading roots from a TTY echoes them. */
  stdinIsTty: () => boolean;
  /**
   * One `open` + `fstat` + read on the SAME file descriptor, so the mode checked is the mode of the file actually
   * read (Rico, delta review of f44e2c6a) — a separate stat-then-read is a time-of-check/time-of-use gap a swap
   * of the path's target between the two calls would slip through.
   */
  openRootFile: (path: string) => Promise<{ mode: number; text: string }>;
}

const usage = (io: Pick<RewrapToolIo, 'log'>, line: string): number => {
  io.log(`db.stamp_key_rewrap.usage: ${line}`);
  return 2;
};

/** Every registry row's key bytes, committed under SHA-256 (the digest never leaves memory). */
async function unwrapDigests(
  db: PrismaClient,
  roots: readonly Buffer[],
  log: (line: string) => void,
): Promise<Map<number, string> | null> {
  const rows = await db.stampSigningKey.findMany({ select: { id: true, keyMaterial: true }, orderBy: { id: 'asc' } });
  const out = new Map<number, string>();
  for (const row of rows) {
    const aad = stampKeyAad(row.id);
    let key: Buffer | null = null;
    for (const root of roots) {
      try {
        key = decryptBytesAad(row.keyMaterial, aad, root);
        break;
      } catch {
        // not under this root — try the next
      }
    }
    if (key === null || key.length !== 32) {
      log(`db.stamp_key_rewrap.verify_failed: key ${row.id} unwraps under neither root (planted or corrupt row)`);
      return null;
    }
    out.set(row.id, createHash('sha256').update(key).digest('hex'));
  }
  return out;
}

export async function main(argv: readonly string[], io: RewrapToolIo): Promise<number> {
  // Roots never travel on argv (Bob P2-C): --from-root-file/--to-root-file (mode 0600) or stdin.
  let fromFile: string | undefined;
  let toFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--from-root-file' && arg !== '--to-root-file') {
      return usage(io, 'roots are never argv: pass --from-root-file/--to-root-file or two stdin lines');
    }
    const path = argv[i + 1];
    if (!path || path.startsWith('--')) return usage(io, `${arg} needs a path`);
    if (arg === '--from-root-file') fromFile = path;
    else toFile = path;
    i++;
  }
  if ((fromFile === undefined) !== (toFile === undefined)) {
    return usage(io, '--from-root-file and --to-root-file come together');
  }

  let fromHex: string;
  let toHex: string;
  if (fromFile !== undefined && toFile !== undefined) {
    const readRootFile = async (path: string, label: string): Promise<string | null> => {
      let mode: number;
      let text: string;
      try {
        ({ mode, text } = await io.openRootFile(path));
      } catch {
        io.log(`db.stamp_key_rewrap.refused_file_read: cannot read the ${label} root file`);
        return null;
      }
      if ((mode & 0o777) !== 0o600) {
        io.log(`db.stamp_key_rewrap.refused_file_mode: the ${label} root file must be mode 0600`);
        return null;
      }
      const trimmed = text.trim();
      if (!HEX64.test(trimmed)) {
        io.log(`db.stamp_key_rewrap.usage: the ${label} root must be 64 hex characters`);
        return null;
      }
      return trimmed;
    };
    const from = await readRootFile(fromFile, 'from');
    if (from === null) return 2;
    const to = await readRootFile(toFile, 'to');
    if (to === null) return 2;
    fromHex = from;
    toHex = to;
  } else {
    if (io.stdinIsTty()) return usage(io, 'stdin is a terminal — the roots would echo; pipe them or use --from-root-file/--to-root-file');
    const lines = (await io.readStdin()).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) return usage(io, 'stdin needs two root lines (from, then to)');
    [fromHex, toHex] = lines;
    if (!HEX64.test(fromHex) || !HEX64.test(toHex)) return usage(io, 'roots must be 64 hex characters');
  }

  if (!io.env.DATABASE_URL) {
    io.log('db.stamp_key_rewrap.database_url_missing');
    return 2;
  }

  const db = new PrismaClient();
  try {
    // BEFORE: commit every row's key bytes (under either explicit root — an idempotent re-run
    // starts with rows already under `to`).
    let before = await unwrapDigests(db, [encryptionKeyFromHex(fromHex), encryptionKeyFromHex(toHex)], io.log);
    if (before === null) return 1;

    let out: { rows: number; rewrapped: number };
    try {
      out = await rewrapStampSigningKeys(db, fromHex, toHex);
    } catch (e) {
      // Named for the operator, without echoing roots or material.
      if (e instanceof StampRegistryUnavailableError) io.log(`db.stamp_key_rewrap.refused: ${e.message}`);
      else io.log('db.stamp_key_rewrap.rewrap_failed');
      return 1;
    }

    // AFTER: same rows, same bytes, now read `to`-first. A changed set (a first mint racing the
    // tool) or a changed digest fails closed — the idempotent re-run settles it.
    const after = await unwrapDigests(db, [encryptionKeyFromHex(toHex), encryptionKeyFromHex(fromHex)], io.log);
    if (after === null || before.size !== after.size || [...before].some(([id, digest]) => after.get(id) !== digest)) {
      io.log(`db.stamp_key_rewrap.verify_failed: rows or material changed across the rewrap (before=${before.size} after=${after?.size ?? 'unreadable'})`);
      return 1;
    }
    before = new Map(); // digests are for the comparison only; drop them before success
    io.log(`db.stamp_key_rewrap ok rows=${out.rows} rewrapped=${out.rewrapped} verified=${after.size}`);
    return 0;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    log: (line) => console.error(line),
    stdinIsTty: () => process.stdin.isTTY === true,
    readStdin: () =>
      new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => (data += chunk));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
      }),
    openRootFile: async (path) => {
      const fh = await open(path, 'r');
      try {
        const { mode } = await fh.stat();
        const text = await readFile(fh, 'utf8');
        return { mode, text };
      } finally {
        await fh.close();
      }
    },
  });
}
