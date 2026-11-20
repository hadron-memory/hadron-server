/**
 * #4003 (S8 of #3991) — rotate one App's secret data key: retire key n, mint n+1 under the current
 * `SECRET_ROOT_KEY`. Ops-script only in v1 (FIT delta 1, option a; Victor under ruling 0265): there is no GraphQL,
 * CLI or MCP surface.
 *
 *   DATABASE_URL=<owner url> SECRET_ROOT_KEY=<from the secret store> pnpm tsx scripts/db/rotate-app-key.ts --app <appId> [--reencrypt]
 *
 * `--reencrypt` (the compromise runbook) also re-encrypts every version of the App under the new key, in the SAME
 * transaction as the rotation, so either both happen or neither does. Without it, old versions stay under their own
 * (retired) key until a later run with the flag. The output carries counts and ids only, never a value.
 *
 * New versions are written under n+1 at once; versions under older keys stay readable (a retired key still
 * unwraps). The root comes from the environment the server itself reads, never argv, and must be the recorded
 * active root (`secret_root_check`), or the run refuses and writes nothing. Runbook:
 * hrn:node:hadronmemory.com:dev:ops:alpha:app-secrets-key-rotation.
 *
 * Exit codes: 0 ok, 1 refused or failed (nothing written), 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { SecretKeyUnavailableError } from '../../src/lib/secrets/appKeys.js';
import { reencryptAppSecretVersions, rotateAppKey } from '../../src/lib/secrets/rotation.js';

const TAG = 'db.secret_app_key_rotate';

export interface RotateToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export async function main(argv: readonly string[], io: RotateToolIo): Promise<number> {
  const reencrypt = argv.length === 3 && argv[2] === '--reencrypt';
  if ((argv.length !== 2 && !reencrypt) || argv[0] !== '--app' || !argv[1] || argv[1].startsWith('--')) {
    io.log(`${TAG}.usage: --app <appId> [--reencrypt]`);
    return 2;
  }
  const appId = argv[1];
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    // A large App's re-encrypt can outlast Prisma's 5 s default; the run is an attended ops step.
    const { handle, moved } = await db.$transaction(async (tx) => {
      const h = await rotateAppKey(tx, appId);
      return { handle: h, moved: reencrypt ? await reencryptAppSecretVersions(tx, appId) : null };
    }, { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 });
    io.log(`${TAG} ok app=${appId} key_version=${handle.keyVersion}${moved === null ? '' : ` reencrypted=${moved}`}`);
    handle.encryptionKey.fill(0);
    handle.fingerprintKey.fill(0);
    return 0;
  } catch (e) {
    io.log(e instanceof SecretKeyUnavailableError
      ? `${TAG}.refused: the root is missing or not the recorded active root, or the App does not exist; nothing was written`
      : `${TAG}.failed`);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env, log: (line) => console.error(line) });
}
