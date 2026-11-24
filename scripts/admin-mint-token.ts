/**
 * Host-side bootstrap-token CLI (issue #300, Option 3; service users #5012).
 *
 * Mint the first `hdr_user_*` credential for a portal-less `hadron-server`
 * directly against the database — no browser, no external IdP. After this,
 * `hadron auth token create` (hadron-cli#68) covers everything else.
 *
 * With a selector it requires an EXISTING user (and never creates one).
 * Identify the user by exactly one selector:
 *
 *   pnpm admin:mint-token --email you@example.com
 *   pnpm admin:mint-token --user-id <id>
 *   pnpm admin:mint-token --handle you
 *   pnpm admin:mint-token --email you@example.com --label "my laptop"
 *
 * `--create-service-user <handle>` instead CREATES a service user with no email
 * whose only platform role is BILLING (#5012), and mints its key:
 *
 *   pnpm admin:mint-token --create-service-user pay-svc
 *
 * Or directly: `npx tsx scripts/admin-mint-token.ts --email you@example.com`.
 *
 * Runs against the server's `DATABASE_URL`. The raw key is printed ONCE — only
 * its SHA-256 hash is persisted, so a lost key is unrecoverable by design.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import {
  mintBootstrapToken,
  mintServiceUser,
  parseMintTokenArgs,
  BootstrapTokenError,
} from '../src/admin/mint-bootstrap-token.js';

const USAGE = `Mint a user token for an EXISTING user (issue #300, Option 3), or create a
billing service user and mint its token (#5012).

Usage:
  pnpm admin:mint-token --email <email>     Mint for the user with this email
  pnpm admin:mint-token --user-id <id>      Mint for the user with this id
  pnpm admin:mint-token --handle <handle>   Mint for the user with this handle
  pnpm admin:mint-token --create-service-user <handle>
                                            Create a service user (no email) whose
                                            only platform role is BILLING, and mint
                                            its token

Options:
  --label <label>   Label for the key (default: "admin-bootstrap", or
                    "billing-service" with --create-service-user)
  -h, --help        Show this help

Exactly one of --email / --user-id / --handle / --create-service-user is
required. A selector requires an existing user and never creates one;
--create-service-user refuses a handle that is already taken (by a user or an
organization). Runs against DATABASE_URL.`;

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseMintTokenArgs(process.argv.slice(2));
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
    const { rawKey, user } = parsed.serviceUserHandle !== undefined
      ? await mintServiceUser(db, { handle: parsed.serviceUserHandle }, { label: parsed.label })
      : await mintBootstrapToken(db, parsed.selector, { label: parsed.label });
    const who = user.email ?? user.handle ?? user.name ?? user.id;
    const what = parsed.serviceUserHandle !== undefined ? 'Created the BILLING service user' : 'Minted a user token for';
    console.log(`\n✓ ${what} ${who} (id: ${user.id})\n`);
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
