/**
 * One-time core→tool Exchange token transfer (#396 Phase 2).
 *
 * For every live ExchangeConnection that still holds a core-encrypted
 * refresh token and has no tool connection yet, decrypt the token with
 * core's HADRON_ENCRYPTION_KEY and import it into the provider tool
 * (hadrontool-ms-exchange re-encrypts under its OWN key), then store the
 * returned tool connection id on the core row.
 *
 * The legacy refresh_token_encrypted column is deliberately NOT cleared here
 * — it is the rollback path until the transfer is verified (list-messages
 * works through the tool per connection), after which a follow-up migration
 * drops the column.
 *
 * Usage (against the target DATABASE_URL + the tool config):
 *   DATABASE_URL=... MS_EXCHANGE_TOOL_URL=... MS_EXCHANGE_TOOL_TOKEN=... \
 *     pnpm admin:transfer-exchange-tokens [--dry-run]
 *
 * Idempotent: rows with a toolConnectionId are skipped, and a failed row is
 * reported and skipped (re-run after fixing the cause).
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { decryptToken } from '../src/lib/tokenCrypto.js';
import { createToolConnection, subscribeToolFolder } from '../src/lib/emailClient.js';

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  if (!process.env.MS_EXCHANGE_TOOL_URL) {
    console.error('MS_EXCHANGE_TOOL_URL is not set — aborting.');
    process.exitCode = 1;
    return;
  }
  const db = new PrismaClient();
  try {
    const pending = await db.exchangeConnection.findMany({
      where: { deletedAt: null, toolConnectionId: null, refreshTokenEncrypted: { not: null } },
      select: { id: true, provider: true, mailboxEmail: true, displayName: true, refreshTokenEncrypted: true },
    });
    console.log(`${pending.length} connection(s) to transfer${dryRun ? ' (dry run)' : ''}`);

    let ok = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        if (dryRun) {
          console.log(`would transfer ${row.mailboxEmail} (${row.id})`);
          continue;
        }
        const refreshToken = decryptToken(row.refreshTokenEncrypted!);
        const identity = await createToolConnection(row.provider, {
          refreshToken,
          mailboxEmail: row.mailboxEmail,
          // The tool's schema takes an OPTIONAL string — null would fail zod.
          displayName: row.displayName ?? undefined,
        });
        await db.exchangeConnection.update({
          where: { id: row.id },
          data: { toolConnectionId: identity.id },
        });
        console.log(`transferred ${row.mailboxEmail} (${row.id}) → tool connection ${identity.id}`);
        // Event plane: best-effort inbox subscription (fails harmlessly until
        // the tool's public webhook route + WEBHOOK_BASE_URL are configured).
        await subscribeToolFolder(row.provider, identity.id, 'inbox').catch((err) => {
          console.log(`  (inbox subscription not created: ${err instanceof Error ? err.message : err})`);
        });
        ok += 1;
      } catch (err) {
        console.error(`FAILED ${row.mailboxEmail} (${row.id}):`, err instanceof Error ? err.message : err);
        failed += 1;
      }
    }
    if (!dryRun) console.log(`done: ${ok} transferred, ${failed} failed, ${pending.length - ok - failed} skipped`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main();
