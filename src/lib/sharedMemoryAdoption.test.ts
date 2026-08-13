/**
 * #723 — the reconciliation sweep that adopts pre-#723 `shared` app-class
 * memories onto the `(appId, sharedMemoryOfAgentId)` column key.
 *
 * The interesting cases are the ones it must REFUSE: a slug that names no
 * installed Agent, a slug that names two, and a pairing another row already
 * holds. Adoption points a team's chat and worklog at a memory, so a wrong
 * guess is worse than a reported skip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { adoptSharedMemories, sharedUrnAgentSlug } from './sharedMemoryAdoption.js';

describe('sharedUrnAgentSlug', () => {
  it('extracts the penultimate atom of a compound shared urn', () => {
    expect(sharedUrnAgentSlug('acme.com:eng-team:iris:shared')).toBe('iris');
  });

  it('tolerates the canonical :: spelling', () => {
    expect(sharedUrnAgentSlug('acme.com::eng-team::iris::shared')).toBe('iris');
  });

  // A flat v2 urn that merely ends in `:shared` is NOT a string-keyed row —
  // reading `acme.com` as the agent slug would be a wild guess.
  it('returns null for a flat <root>:shared urn', () => {
    expect(sharedUrnAgentSlug('acme.com:shared')).toBeNull();
  });

  // A createMemoryInApp memory a user named "shared": the `app-mem` marker sits
  // where the agent slug would be, so it is not a runtime shared memory.
  it('returns null for a `…:app-mem:shared` named memory', () => {
    expect(sharedUrnAgentSlug('acme.com:eng-team:iris:app-mem:shared')).toBeNull();
  });

  it('returns null for a urn that does not end in :shared, and for null', () => {
    expect(sharedUrnAgentSlug('acme.com:eng-team:iris:notes')).toBeNull();
    expect(sharedUrnAgentSlug(null)).toBeNull();
  });
});

describe('adoptSharedMemories', () => {
  let orgId: string;
  let orgUrn: string;
  let appId: string;
  let appUrn: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanDb(db);
    const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const org = await db.organization.create({
      data: { id: generateId(), name: 'adopt-org', urn: `adopt-${s}.com` },
    });
    orgId = org.id;
    orgUrn = org.urn;
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: `${orgUrn}:iris`, name: 'Iris' },
    });
    agentId = agent.id;
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${orgUrn}:eng-team`,
        name: 'Eng Team',
        appType: 'CHATBOT',
        appAgents: { create: { agentId: agent.id } },
      },
    });
    appId = app.id;
    appUrn = app.urn;
  });

  /** A pre-#723 shared memory, string-keyed by `urn` (or by `legacyUrn`). */
  async function legacyShared(columns: { urn: string; legacyUrn?: string }) {
    return db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        name: 'legacy shared',
        class: 'app',
        appId,
        ...columns,
      },
    });
  }

  const silent = { log: () => {} };

  it('adopts a compound-urn row and reports it as still needing the urn backfill', async () => {
    const row = await legacyShared({ urn: `${appUrn}:iris:shared` });
    const stats = await adoptSharedMemories(db, silent);
    expect(stats.adopted).toBe(1);
    expect(stats.stillCompoundUrn).toBe(1);
    expect(
      (await db.memory.findUniqueOrThrow({ where: { id: row.id } })).sharedMemoryOfAgentId,
    ).toBe(agentId);
  });

  it('adopts a Task-A-migrated row off legacyUrn, and leaves its flat urn alone', async () => {
    const row = await legacyShared({
      urn: `${orgUrn}:shared`,
      legacyUrn: `${appUrn}:iris:shared`,
    });
    const stats = await adoptSharedMemories(db, silent);
    expect(stats.adopted).toBe(1);
    expect(stats.stillCompoundUrn).toBe(0);
    const after = await db.memory.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.sharedMemoryOfAgentId).toBe(agentId);
    expect(after.urn).toBe(`${orgUrn}:shared`);
  });

  it('is idempotent — a second run adopts nothing', async () => {
    await legacyShared({ urn: `${appUrn}:iris:shared` });
    await adoptSharedMemories(db, silent);
    const second = await adoptSharedMemories(db, silent);
    expect(second.adopted).toBe(0);
    expect(second.alreadyKeyed).toBe(1);
  });

  it('skips a slug that names no Agent installed in the App', async () => {
    const row = await legacyShared({ urn: `${appUrn}:ghost:shared` });
    const stats = await adoptSharedMemories(db, silent);
    expect(stats.adopted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(
      (await db.memory.findUniqueOrThrow({ where: { id: row.id } })).sharedMemoryOfAgentId,
    ).toBeNull();
  });

  // Two Agents can present the same slug — one on its current urn, one on the
  // pre-#697 urn the Task-A sweep re-slugged it away from. Undecidable.
  it('skips an ambiguous slug rather than guessing', async () => {
    const twin = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${orgUrn}:iris-2`,
        legacyUrn: `${orgUrn}:iris`,
        name: 'Iris (re-slugged)',
      },
    });
    await db.appAgent.create({ data: { appId, agentId: twin.id } });
    await legacyShared({ urn: `${appUrn}:iris:shared` });
    const stats = await adoptSharedMemories(db, silent);
    expect(stats.adopted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('skips a second row for a pairing another memory already holds', async () => {
    const holder = await legacyShared({ urn: `${appUrn}:iris:shared` });
    // A duplicate that an App rename could have produced under the old key.
    const dupe = await legacyShared({ urn: `${orgUrn}:eng-team-renamed:iris:shared` });
    const stats = await adoptSharedMemories(db, silent);
    expect(stats.adopted).toBe(1);
    expect(stats.skipped).toBe(1);
    const [a, b] = await Promise.all([
      db.memory.findUniqueOrThrow({ where: { id: holder.id } }),
      db.memory.findUniqueOrThrow({ where: { id: dupe.id } }),
    ]);
    // Oldest wins; the loser keeps its content and is reported, never re-keyed.
    expect(a.sharedMemoryOfAgentId).toBe(agentId);
    expect(b.sharedMemoryOfAgentId).toBeNull();
  });

  it('writes nothing in a dry run', async () => {
    const row = await legacyShared({ urn: `${appUrn}:iris:shared` });
    const stats = await adoptSharedMemories(db, { ...silent, dryRun: true });
    expect(stats.adopted).toBe(1);
    expect(
      (await db.memory.findUniqueOrThrow({ where: { id: row.id } })).sharedMemoryOfAgentId,
    ).toBeNull();
  });
});
