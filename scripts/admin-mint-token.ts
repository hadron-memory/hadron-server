/**
 * Host-side bootstrap-token CLI (issue #300, Option 3).
 *
 * Mint the first `hdr_user_*` credential for a portal-less `hadron-server`
 * directly against the database — no browser, no external IdP. After this,
 * `hadron auth token create` (hadron-cli#68) covers everything else.
 *
 * Requires an EXISTING user (this never creates one). Identify the user by
 * exactly one selector:
 *
 *   pnpm admin:mint-token --email you@example.com
 *   pnpm admin:mint-token --user-id <id>
 *   pnpm admin:mint-token --handle you
 *   pnpm admin:mint-token --email you@example.com --label "my laptop"
 *
 * Or directly: `npx tsx scripts/admin-mint-token.ts --email you@example.com`.
 *
 * Runs against the server's `DATABASE_URL`. The raw key is printed ONCE — only
 * its SHA-256 hash is persisted, so a lost key is unrecoverable by design.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import {
  mintBootstrapToken,
  BootstrapTokenError,
  type UserSelector,
} from '../src/admin/mint-bootstrap-token.js';

const USAGE = `Mint a bootstrap user token for an EXISTING user (issue #300, Option 3).

Usage:
  pnpm admin:mint-token --email <email>     Mint for the user with this email
  pnpm admin:mint-token --user-id <id>      Mint for the user with this id
  pnpm admin:mint-token --handle <handle>   Mint for the user with this handle

Options:
  --label <label>   Label for the key (default: "admin-bootstrap")
  -h, --help        Show this help

Exactly one selector (--email / --user-id / --handle) is required. This command
requires an existing user and never creates one. Runs against DATABASE_URL.`;

/** Minimal `--key value` / `--key=value` parser (no arg-parsing dep in repo). */
function parseArgs(argv: string[]): { selector: UserSelector; label?: string; help: boolean } {
  const selector: UserSelector = {};
  let label: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const valueFor = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new BootstrapTokenError(`Missing value for ${key}.`);
      }
      i++;
      return next;
    };

    switch (key) {
      case '--email':
        selector.email = valueFor();
        break;
      case '--user-id':
        selector.userId = valueFor();
        break;
      case '--handle':
        selector.handle = valueFor();
        break;
      case '--label':
        label = valueFor();
        break;
      default:
        throw new BootstrapTokenError(`Unknown argument: ${arg}`);
    }
  }

  return { selector, label, help };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  const db = new PrismaClient();
  try {
    const { rawKey, user } = await mintBootstrapToken(db, parsed.selector, {
      label: parsed.label,
    });
    const who = user.email ?? user.handle ?? user.name ?? user.id;
    console.log(`\n✓ Minted a user token for ${who} (id: ${user.id})\n`);
    console.log(rawKey);
    console.log(
      '\nThis is shown ONCE — store it now. Use it as a Bearer token, e.g.:\n' +
        `  hadron auth login --token ${rawKey.slice(0, 12)}…\n` +
        'After this first token, `hadron auth token create` can mint and manage the rest.',
    );
  } catch (err) {
    if (err instanceof BootstrapTokenError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error('Failed to mint bootstrap token:', err);
    }
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main();
