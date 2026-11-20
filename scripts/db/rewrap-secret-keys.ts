/**
 * #4003 (S8 of #3991; R18) — root rotation of the App secret store: re-wrap every App data key
 * (`secret_app_keys`) from the old `SECRET_ROOT_KEY` to the new one, and move the root's key-check value with
 * them. Modelled on the stamp-key tool (`scripts/db/rewrap-stamp-signing-keys.ts`, #2973).
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/rewrap-secret-keys.ts \
 *       --from-root-file /run/secrets/secret-root-from --to-root-file /run/secrets/secret-root-to
 *   # or, with no flags, two root lines on piped stdin (from first, then to)
 *
 * The roots NEVER appear on the command line: argv is world-readable through ps and /proc/<pid>/cmdline and lands
 * in shell history. They come from mode-0600 files (a looser mode is refused; mode and bytes are read from the same
 * descriptor) or from piped stdin (a terminal is refused, since it would echo them). They are validated as 64 hex
 * characters and never logged.
 *
 * The re-wrap is one transaction ({@link rewrapSecretRootKeys}): atomic, idempotent, holding the secrets-root lock
 * that every mint holds shared. Verification is real: BEFORE, every row is unwrapped (under either root, since a
 * re-run starts with rows already under the new one) and SHA-256-committed in memory; AFTER, every row is unwrapped
 * under the NEW root ONLY and the commitments compared, so a re-wrap that wrote nothing exits 1. The digests are
 * never printed. An instance still running the old root after the switch mints nothing (the key-check value moved),
 * but the runbook still stops writers first and re-runs this tool after the switch as the proof. The inverse
 * argument order is the rollback. Runbook: hrn:node:hadronmemory.com:dev:ops:alpha:app-secrets-key-rotation.
 *
 * Exit codes: 0 ok, 1 failed (re-wrap or verify), 2 usage (bad input, open file mode, no DATABASE_URL).
 */
import { createHash } from 'crypto';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { appKeyAad, SecretKeyUnavailableError } from '../../src/lib/secrets/appKeys.js';
import { rewrapSecretRootKeys } from '../../src/lib/secrets/rotation.js';
import { decryptBytesAad } from '../../src/lib/tokenCrypto.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const TAG = 'db.secret_root_rewrap';

/** Everything {@link main} touches outside its own logic, injectable so tests drive the real exit codes. */
export interface SecretRewrapToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  readStdin: () => Promise<string>;
  stdinIsTty: () => boolean;
  /** One open + fstat + read on the same descriptor, so the mode checked is the mode of the file read. */
  openRootFile: (path: string) => Promise<{ mode: number; text: string }>;
}

const usage = (io: Pick<SecretRewrapToolIo, 'log'>, line: string): number => {
  io.log(`${TAG}.usage: ${line}`);
  return 2;
};

/** Every App key row's bytes, SHA-256-committed in memory, or null (logged) if a row unwraps under none of `roots`. */
async function unwrapDigests(
  db: PrismaClient,
  roots: readonly Buffer[],
  phase: 'before' | 'after',
  log: (line: string) => void,
): Promise<Map<string, string> | null> {
  const rows = await db.secretAppKey.findMany({
    select: { appId: true, keyVersion: true, wrappedKey: true },
    orderBy: [{ appId: 'asc' }, { keyVersion: 'asc' }],
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    let key: Buffer | null = null;
    for (const root of roots) {
      try {
        key = decryptBytesAad(row.wrappedKey, appKeyAad(row.appId, row.keyVersion), root);
        break;
      } catch {
        // not under this root
      }
    }
    if (key === null || key.length !== 32) {
      key?.fill(0);
      log(phase === 'before'
        ? `${TAG}.verify_failed: an App key unwraps under neither root (planted or corrupt row; app ${row.appId} version ${row.keyVersion})`
        : `${TAG}.verify_failed: an App key does not unwrap under the NEW root (app ${row.appId} version ${row.keyVersion}); stop writers and re-run`);
      return null;
    }
    out.set(`${row.appId}:${row.keyVersion}`, createHash('sha256').update(key).digest('hex'));
    key.fill(0);
  }
  return out;
}

export async function main(argv: readonly string[], io: SecretRewrapToolIo): Promise<number> {
  let fromFile: string | undefined;
  let toFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--from-root-file' && arg !== '--to-root-file') {
      return usage(io, 'roots are never argv: pass --from-root-file/--to-root-file or two piped stdin lines');
    }
    const path = argv[i + 1];
    if (!path || path.startsWith('--')) return usage(io, `${arg} needs a path`);
    if (arg === '--from-root-file') fromFile = path;
    else toFile = path;
    i++;
  }
  if ((fromFile === undefined) !== (toFile === undefined)) return usage(io, '--from-root-file and --to-root-file come together');

  let fromHex: string;
  let toHex: string;
  if (fromFile !== undefined && toFile !== undefined) {
    const readRootFile = async (path: string, label: string): Promise<string | null> => {
      let mode: number;
      let text: string;
      try {
        ({ mode, text } = await io.openRootFile(path));
      } catch {
        io.log(`${TAG}.refused_file_read: cannot read the ${label} root file`);
        return null;
      }
      if ((mode & 0o777) !== 0o600) {
        io.log(`${TAG}.refused_file_mode: the ${label} root file must be mode 0600`);
        return null;
      }
      const trimmed = text.trim();
      if (!HEX64.test(trimmed)) {
        io.log(`${TAG}.usage: the ${label} root must be 64 hex characters`);
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
    if (io.stdinIsTty()) return usage(io, 'stdin is a terminal and the roots would echo; pipe them or use --from-root-file/--to-root-file');
    const lines = (await io.readStdin()).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) return usage(io, 'stdin needs two root lines (from, then to)');
    [fromHex, toHex] = lines;
    if (!HEX64.test(fromHex) || !HEX64.test(toHex)) return usage(io, 'roots must be 64 hex characters');
  }

  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }

  const fromRoot = Buffer.from(fromHex, 'hex');
  const toRoot = Buffer.from(toHex, 'hex');
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    const before = await unwrapDigests(db, [fromRoot, toRoot], 'before', io.log);
    if (before === null) return 1;
    let out: { rows: number; rewrapped: number };
    try {
      out = await rewrapSecretRootKeys(db, fromHex, toHex);
    } catch (e) {
      io.log(e instanceof SecretKeyUnavailableError ? `${TAG}.refused: an App key unwraps under neither root; nothing was changed` : `${TAG}.rewrap_failed`);
      return 1;
    }
    const after = await unwrapDigests(db, [toRoot], 'after', io.log);
    if (after === null || before.size !== after.size || [...before].some(([k, digest]) => after.get(k) !== digest)) {
      io.log(`${TAG}.verify_failed: rows or key bytes changed across the re-wrap (before=${before.size} after=${after?.size ?? 'unreadable'})`);
      return 1;
    }
    io.log(`${TAG} ok rows=${out.rows} rewrapped=${out.rewrapped} verified=${after.size}`);
    return 0;
  } finally {
    fromRoot.fill(0);
    toRoot.fill(0);
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
        return { mode, text: await readFile(fh, 'utf8') };
      } finally {
        await fh.close();
      }
    },
  });
}
