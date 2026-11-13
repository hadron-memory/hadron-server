/**
 * #4003 (S8 of #3991) — rotate one App's secret data key: retire key n, mint n+1 under the current
 * `SECRET_ROOT_KEY`. Ops-script only in v1 (FIT delta 1, option a; Victor under ruling 0265): there is no GraphQL,
 * CLI or MCP surface.
 *
 *   DATABASE_URL=<owner url> SECRET_ROOT_KEY=<from the secret store> pnpm tsx scripts/db/rotate-app-key.ts --app <appId>
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
import { rotateAppKey } from '../../src/lib/secrets/rotation.js';

const TAG = 'db.secret_app_key_rotate';

export interface RotateToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export async function main(argv: readonly string[], io: RotateToolIo): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--app' || !argv[1] || argv[1].startsWith('--')) {
    io.log(`${TAG}.usage: --app <appId>`);
    return 2;
  }
  const appId = argv[1];
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    const handle = await db.$transaction((tx) => rotateAppKey(tx, appId));
    io.log(`${TAG} ok app=${appId} key_version=${handle.keyVersion}`);
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
