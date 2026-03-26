/**
 * One-time migration: convert all existing CUID primary keys to UUIDv7 (no dashes).
 *
 * Run with: npx tsx scripts/migrate-ids-to-uuidv7.ts
 *
 * Safe to run multiple times — skips IDs that are already 32-char hex (UUIDv7 format).
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { generateId } from '../src/lib/id.js';

const db = new PrismaClient();

// Tables whose `id` column should be migrated, and the FK columns that reference them.
// Format: { table, fkRefs: [{ table, column }] }
const ENTITIES = [
  {
    table: 'users',
    fkRefs: [
      { table: 'org_members', column: 'user_id' },
      { table: 'stations', column: 'user_id' },
      { table: 'org_member_invitations', column: 'recipient_user_id' },
      { table: 'user_invitations', column: 'sender_user_id' },
      { table: 'user_invitations', column: 'new_user_id' },
      { table: 'user_invitation_activations', column: 'user_id' },
      { table: 'pending_setups', column: 'user_id' },
    ],
  },
  {
    table: 'organizations',
    fkRefs: [
      { table: 'org_members', column: 'organization_id' },
      { table: 'stations', column: 'organization_id' },
      { table: 'memories', column: 'organization_id' },
      { table: 'agents', column: 'organization_id' },
      { table: 'memory_subscriptions', column: 'organization_id' },
      { table: 'user_invitations', column: 'organization_id' },
    ],
  },
  {
    table: 'memories',
    fkRefs: [
      { table: 'nodes', column: 'memory_id' },
      { table: 'agent_memory_items', column: 'memory_id' },
      { table: 'memory_subscriptions', column: 'memory_id' },
      { table: 'memory_licenses', column: 'memory_id' },
      { table: 'memory_log', column: 'memory_id' },
    ],
  },
  {
    table: 'agents',
    fkRefs: [
      { table: 'agent_memory_items', column: 'agent_id' },
      { table: 'station_agent_subscriptions', column: 'agent_id' },
    ],
  },
  {
    table: 'stations',
    fkRefs: [
      { table: 'station_agent_subscriptions', column: 'station_id' },
      { table: 'sessions', column: 'station_id' },
      { table: 'usage_events', column: 'station_id' },
      { table: 'station_log', column: 'station_id' },
    ],
  },
  {
    table: 'nodes',
    fkRefs: [
      { table: 'edges', column: 'source_id' },
      { table: 'edges', column: 'target_id' },
      { table: 'pending_edges', column: 'source_id' },
      { table: 'usage_events', column: 'node_id' },
      { table: 'node_versions', column: 'node_id' },
    ],
  },
  {
    table: 'sessions',
    fkRefs: [
      { table: 'usage_events', column: 'session_id' },
      { table: 'sessions', column: 'parent_session_id' },
      { table: 'sessions', column: 'prev_session_id' },
    ],
  },
  // Tables with IDs but no incoming FKs (or only self-contained)
  { table: 'org_members', fkRefs: [{ table: 'org_member_invitations', column: 'member_user_id' }] },
  { table: 'memory_licenses', fkRefs: [{ table: 'memory_subscriptions', column: 'license_id' }] },
  { table: 'hadron_server', fkRefs: [{ table: 'server_log', column: 'server_id' }] },
  { table: 'user_invitations', fkRefs: [{ table: 'user_invitation_activations', column: 'invitation_id' }] },
  // Leaf tables (no incoming FKs)
  { table: 'edges', fkRefs: [] },
  { table: 'pending_edges', fkRefs: [] },
  { table: 'usage_events', fkRefs: [] },
  { table: 'node_versions', fkRefs: [] },
  { table: 'station_agent_subscriptions', fkRefs: [] },
  { table: 'agent_memory_items', fkRefs: [] },
  { table: 'memory_subscriptions', fkRefs: [] },
  { table: 'station_log', fkRefs: [] },
  { table: 'memory_log', fkRefs: [] },
  { table: 'server_log', fkRefs: [] },
  { table: 'org_member_invitations', fkRefs: [] },
  { table: 'user_invitation_activations', fkRefs: [] },
  { table: 'pending_setups', fkRefs: [] },
  { table: 'email_verification_tokens', fkRefs: [] },
];

function isCuid(id: string): boolean {
  // CUIDs start with 'c' and are 25 chars; UUIDv7 hex is 32 chars, all hex
  return /^c[a-z0-9]{24}$/.test(id);
}

async function main() {
  console.log('Starting ID migration to UUIDv7...\n');

  // Build old→new mapping for all tables
  const mappings = new Map<string, Map<string, string>>();

  for (const entity of ENTITIES) {
    const rows: Array<{ id: string }> = await db.$queryRawUnsafe(
      `SELECT id FROM "${entity.table}"`,
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      if (isCuid(row.id)) {
        map.set(row.id, generateId());
      }
    }
    if (map.size > 0) {
      mappings.set(entity.table, map);
      console.log(`  ${entity.table}: ${map.size} IDs to migrate`);
    }
  }

  const totalIds = [...mappings.values()].reduce((sum, m) => sum + m.size, 0);
  if (totalIds === 0) {
    console.log('\nNo CUID IDs found — nothing to migrate.');
    await db.$disconnect();
    return;
  }

  console.log(`\nTotal: ${totalIds} IDs to migrate. Running in transaction...\n`);

  await db.$transaction(async (tx) => {
    for (const entity of ENTITIES) {
      const map = mappings.get(entity.table);
      if (!map || map.size === 0) continue;

      // For each row: update the PK first, then update all FK references.
      // After the PK update the new value exists, so FK updates succeed.
      for (const [oldId, newId] of map) {
        await tx.$executeRawUnsafe(
          `UPDATE "${entity.table}" SET id = $1 WHERE id = $2`,
          newId,
          oldId,
        );
        for (const fk of entity.fkRefs) {
          await tx.$executeRawUnsafe(
            `UPDATE "${fk.table}" SET "${fk.column}" = $1 WHERE "${fk.column}" = $2`,
            newId,
            oldId,
          );
        }
      }

      console.log(`  ✓ ${entity.table}: ${map.size} IDs updated`);
    }
  }, { timeout: 120_000 });

  console.log('\nDone! All IDs migrated to UUIDv7.');
  await db.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
