/**
 * #3196 (slice 7 of the #3187 time-zone audit): nine active raw INSERTs omit `created_at` and so take the column's
 * `DEFAULT CURRENT_TIMESTAMP`. Every one of those columns is a `timestamp` with no zone that holds UTC, and the default is
 * evaluated as the SESSION's local wall time, so under a non-UTC session the row is stamped hours early (west of UTC) or
 * late (east of UTC). Every pin runs the writer through a client whose OWN connection carries the zone
 * (`options=-c TimeZone=<zone>`, the #3182 harness of sweepGitMirrorObligations3174.test.ts); the shared test database
 * and its session setting are never changed. Read back through the shared (UTC) client, each `created_at` must sit at UTC
 * now within a bound far below the smallest offset in play (LA -8h, Tokyo +9h).
 *
 * One pin per writer: memory_configs (materializeConfig), agent_org_grants (ensureAgentOrgGrant), register_entries
 * (ensureInstallRegisterRows), and urn_aliases x3 per cascade (renameOwnerNamespacedUrns, propagateOrgUrnRename: one
 * INSERT each for memories, agents and apps).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { materializeConfig } from '../api/graphql/schema/resolvers.memoryConfig.js';
import { ensureAgentOrgGrant } from '../controller/operations/ensureAgentOrgGrant.js';
import { ensureChannelWithRoot } from './channels.js';
import { ensureInstallRegisterRows } from './registerInstall.js';
import { renameOwnerNamespacedUrns } from './ownerUrnRename.js';
import { propagateOrgUrnRename } from './org/propagateOrgUrnRename.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
/** Far below any zone offset in play, far above DB-vs-JS clock skew on one host. */
const BOUND_MS = 60_000;
const clients = new Map<string, PrismaClient>();

/** A client whose own connection runs in `zone`. */
function zoneClient(zone: string): PrismaClient {
  let client = clients.get(zone);
  if (!client) {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}`);
    client = new PrismaClient({ datasourceUrl: url.toString() });
    clients.set(zone, client);
  }
  return client;
}

/** Run `write`, then assert every stamp it produced sits at UTC now (within the bound). */
async function expectStampedAtUtcNow(write: () => Promise<unknown>, read: () => Promise<Array<{ label: string; createdAt: Date }>>) {
  const before = Date.now();
  await write();
  const after = Date.now();
  const rows = await read();
  expect(rows.length).toBeGreaterThan(0);
  for (const { label, createdAt } of rows) {
    const t = createdAt.getTime();
    expect(t, `${label}: created_at ${createdAt.toISOString()} outside [now - bound, now + bound]`).toBeGreaterThanOrEqual(before - BOUND_MS);
    expect(t, `${label}: created_at ${createdAt.toISOString()} outside [now - bound, now + bound]`).toBeLessThanOrEqual(after + BOUND_MS);
  }
}

let org: { id: string; urn: string };
let user: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'tz', urn: `tz3196-${t}` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 3196_000 + Math.floor(Math.random() * 1000), githubUsername: `tz3196-${t}` } });
});
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

describe.each(ZONES)('#3196 raw writers stamp created_at in UTC under session zone %s', zone => {
  it('memory_configs: materializeConfig', async () => {
    const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge' } });
    await expectStampedAtUtcNow(
      () => zoneClient(zone).$transaction(tx => materializeConfig(tx, memory.id, user.id)),
      async () => (await db.memoryConfig.findMany({ where: { memoryId: memory.id } })).map(r => ({ label: 'memory_configs', createdAt: r.createdAt })),
    );
  });

  it('agent_org_grants: ensureAgentOrgGrant', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' } });
    await expectStampedAtUtcNow(
      () => ensureAgentOrgGrant(zoneClient(zone), org.id, agent.id),
      async () => (await db.agentOrgGrant.findMany({ where: { orgId: org.id, agentId: agent.id } })).map(r => ({ label: 'agent_org_grants', createdAt: r.createdAt })),
    );
  });

  it('register_entries: ensureInstallRegisterRows', async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
    const appMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
    });
    // The default Channel first, while nothing is installed, so the channel helper writes no register row itself.
    await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    expect(await db.registerEntry.count({ where: { appId: app.id } })).toBe(0);
    await expectStampedAtUtcNow(
      async () => expect(await ensureInstallRegisterRows(zoneClient(zone), app.id)).toBe(1),
      async () => (await db.registerEntry.findMany({ where: { appId: app.id } })).map(r => ({ label: 'register_entries', createdAt: r.createdAt })),
    );
  });

  it('urn_aliases: renameOwnerNamespacedUrns (memory, agent and app INSERTs)', async () => {
    const oldHandle = `old${Math.floor(Math.random() * 1e6)}`;
    const mem = await db.memory.create({ data: { id: generateId(), ownerUserId: user.id, name: 'M', urn: `${oldHandle}:notes`, class: 'personal', userId: user.id } });
    const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: user.id, name: 'G', urn: `${oldHandle}:helper` } });
    const app = await db.app.create({ data: { id: generateId(), ownerUserId: user.id, name: 'A', urn: `${oldHandle}:tool` } });
    const labels = new Map([[mem.id, 'owner rename: MEMORY'], [agent.id, 'owner rename: AGENT'], [app.id, 'owner rename: APP']]);
    await expectStampedAtUtcNow(
      () => zoneClient(zone).$transaction(tx => renameOwnerNamespacedUrns(tx, user.id, oldHandle, `new${oldHandle}`)),
      async () => {
        const rows = await db.urnAlias.findMany({ where: { entityId: { in: [...labels.keys()] } } });
        expect(new Set(rows.map(r => r.entityId))).toEqual(new Set(labels.keys())); // all three writers ran
        return rows.map(r => ({ label: labels.get(r.entityId)!, createdAt: r.createdAt }));
      },
    );
  });

  it('urn_aliases: propagateOrgUrnRename (memory, agent and app INSERTs)', async () => {
    const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:docs`, name: 'docs', class: 'knowledge' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:helper`, name: 'helper' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:team` } });
    const labels = new Map([[mem.id, 'org rename: MEMORY'], [agent.id, 'org rename: AGENT'], [app.id, 'org rename: APP']]);
    await expectStampedAtUtcNow(
      () => zoneClient(zone).$transaction(tx => propagateOrgUrnRename(tx, org.id, org.urn, `${org.urn}-renamed`, { createdBy: user.id })),
      async () => {
        const rows = await db.urnAlias.findMany({ where: { entityId: { in: [...labels.keys()] } } });
        expect(new Set(rows.map(r => r.entityId))).toEqual(new Set(labels.keys())); // all three writers ran
        return rows.map(r => ({ label: labels.get(r.entityId)!, createdAt: r.createdAt }));
      },
    );
  });
});
