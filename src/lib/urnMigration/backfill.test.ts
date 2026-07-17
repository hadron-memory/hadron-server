/**
 * URN-v2 backfill sweep (#697, Task A) — end to end against the DB.
 *
 * Asserts the #697 acceptance criteria: after the backfill an old chain / `::` /
 * `@` / `urn:` reference resolves through the stored alias map to the migrated
 * row; byte-identical rows only get `urnNormalizedAt`; a collision mints an
 * author-derived alias; a root with no live principal fails softly and is
 * skipped on re-run; the sweep is idempotent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { backfillUrnV2 } from './backfill.js';
import { resolveMemoryRef } from '../entityRef/memoryRef.js';
import { resolveAgentRef } from '../entityRef/agentRef.js';

const noop = (): void => {};

/** Reserve a root name in the pool so the backfill's liveness check passes. */
async function seedPrincipal(name: string, kind: 'org' | 'user'): Promise<void> {
  await db.principal.create({
    data: { id: generateId(), name: name.toLowerCase(), kind, status: 'active' },
  });
}

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  await seedPrincipal('acme.com', 'org');
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme.com' },
  });
  orgId = org.id;
});

describe('backfillUrnV2', () => {
  it('collapses a compound app-user memory and resolves the old chain URN via the alias map', async () => {
    const legacy = 'acme.com:code-gen:app-user:0192abcdef';
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: legacy, name: 'per-user', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe('acme.com:0192abcdef');
    expect(after.legacyUrn).toBe(legacy);
    expect(after.urnNormalizedAt).not.toBeNull();

    // Acceptance: the OLD chain URN (any spelling) still resolves to the row.
    expect(await resolveMemoryRef(db, 'hrn:memory:acme.com::code-gen::app-user:0192abcdef')).toEqual({ id: mem.id });
    expect(await resolveMemoryRef(db, 'urn:memory:acme.com:code-gen:app-user:0192abcdef')).toEqual({ id: mem.id });
    // The canonical v1 spelling of the NEW slug also resolves (primary `urn`
    // hit). NB: a v2-native `hrn:mem:…` input resolving is Task B's emission
    // flip (the resolver still parses v1 input shapes here).
    expect(await resolveMemoryRef(db, 'hrn:memory:acme.com::0192abcdef')).toEqual({ id: mem.id });
  });

  it('leaves a byte-identical org-rooted memory in place (only marks normalized, no legacyUrn)', async () => {
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:notes', name: 'notes', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe('acme.com:notes');
    expect(after.legacyUrn).toBeNull();
    expect(after.urnNormalizedAt).not.toBeNull();
    expect(await resolveMemoryRef(db, 'hrn:memory:acme.com::notes')).toEqual({ id: mem.id });
  });

  it('drops the @ sigil on a user-owned agent and resolves the legacy owner URN', async () => {
    await seedPrincipal('holger', 'user');
    const user = await db.user.create({
      data: { id: generateId(), handle: 'holger', email: `h-${generateId()}@x.test` },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), ownerUserId: user.id, urn: '@holger:helper', name: 'helper' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(after.urn).toBe('holger:helper');
    expect(after.legacyUrn).toBe('@holger:helper');
    expect(await resolveAgentRef(db, 'hrn:agent:@holger:helper')).toEqual({ id: agent.id });
    expect(await resolveAgentRef(db, 'hrn:agent:holger:helper')).toEqual({ id: agent.id });
  });

  it('mints an author-derived alias when the collapsed slug collides', async () => {
    // A byte-identical row already owns `acme.com:dup`…
    await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:dup', name: 'dup', class: 'knowledge' },
    });
    // …so a compound memory whose terminal atom is also `dup` must alias.
    const collider = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:reviewer:app-user:dup', name: 'c', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: collider.id } });
    expect(after.urn).toBe('acme.com:dup-reviewer'); // authorRoot = the agent segment
    expect(after.legacyUrn).toBe('acme.com:reviewer:app-user:dup');
    expect(await resolveMemoryRef(db, 'hrn:memory:acme.com::reviewer::app-user:dup')).toEqual({ id: collider.id });
  });

  it('re-homes a memory whose URN root diverges from its owning org (the shadowbrush case)', async () => {
    // Owned by acme.com but stored under a stale root — the FK is authoritative.
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'shadowbrush.com:recipes', name: 'r', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe('acme.com:recipes'); // re-rooted onto the real owner
    expect(after.legacyUrn).toBe('shadowbrush.com:recipes');
    // The old, divergent URN still resolves via the alias map.
    expect(await resolveMemoryRef(db, 'hrn:memory:shadowbrush.com::recipes')).toEqual({ id: mem.id });
  });

  it('collapses a canonical `::`-stored URN to single-colon v2 without a bogus alias', async () => {
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com::planner', name: 'p', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe('acme.com:planner'); // `::` collapsed
    expect(after.legacyUrn).toBeNull(); // same lookup key → no redirect needed
    expect(after.urnNormalizedAt).not.toBeNull();
    expect(await resolveMemoryRef(db, 'hrn:memory:acme.com::planner')).toEqual({ id: mem.id });
  });

  it('does not mint a new URN that shadows another row\'s legacyUrn', async () => {
    // A previously-migrated row whose OLD identity `acme.com:taken` is now a legacy alias.
    await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:moved', legacyUrn: 'acme.com:taken', name: 'm', class: 'knowledge' },
    });
    // A compound row whose terminal atom `taken` would collapse onto that legacy key.
    const collider = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:writer:app-user:taken', name: 'c', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: collider.id } });
    // Must NOT become `acme.com:taken` (would shadow the other row's legacy identity).
    expect(after.urn).not.toBe('acme.com:taken');
    expect(after.urn).toBe('acme.com:taken-writer'); // author-derived alias instead
  });

  it('roots a user-owned memory on the owner handle from the FK (XOR dispatch)', async () => {
    await seedPrincipal('holger2', 'user');
    const user = await db.user.create({
      data: { id: generateId(), handle: 'holger2', email: `h2-${generateId()}@x.test` },
    });
    // owner_xor: a user-owned memory has organizationId NULL, ownerUserId set.
    const mem = await db.memory.create({
      data: { id: generateId(), ownerUserId: user.id, urn: '@holger2:my-notes', name: 's', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe('holger2:my-notes'); // rooted on the handle, @ dropped
    expect(after.legacyUrn).toBe('@holger2:my-notes');
    expect(await resolveMemoryRef(db, 'hrn:memory:@holger2:my-notes')).toEqual({ id: mem.id });
  });

  it('fails softly when the owner root is not a live principal, and skips it on re-run', async () => {
    // An org with NO seeded principal owns this row.
    const noPoolOrg = await db.organization.create({
      data: { id: generateId(), name: 'NoPool', urn: 'nopool.com' },
    });
    const orphan = await db.memory.create({
      data: { id: generateId(), organizationId: noPoolOrg.id, urn: 'nopool.com:orphan', name: 'orphan', class: 'knowledge' },
    });

    const first = await backfillUrnV2(db, { log: noop });
    const memStats = first.find((s) => s.entity === 'mem')!;
    expect(memStats.failed).toBe(1);

    const after = await db.memory.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(after.urn).toBe('nopool.com:orphan'); // untouched
    expect(after.urnNormalizedAt).toBeNull();
    expect(after.urnMigrationFailedReason).toMatch(/not a live org principal/);

    // Re-run: the failed row is excluded from the pending set (no infinite retry).
    const second = await backfillUrnV2(db, { log: noop });
    expect(second.find((s) => s.entity === 'mem')!.failed).toBe(0);
    expect(second.find((s) => s.entity === 'mem')!.migrated).toBe(0);
  });

  it('is idempotent — a second run migrates nothing', async () => {
    await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:code-gen:app-user:xyz', name: 'p', class: 'knowledge' },
    });

    await backfillUrnV2(db, { log: noop });
    const second = await backfillUrnV2(db, { log: noop });
    const memStats = second.find((s) => s.entity === 'mem')!;
    expect(memStats.migrated).toBe(0);
    expect(memStats.unchanged).toBe(0);
    expect(memStats.failed).toBe(0);
  });

  it('previews without writing in dry-run mode', async () => {
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'acme.com:code-gen:app-user:dryrun', name: 'p', class: 'knowledge' },
    });

    const stats = await backfillUrnV2(db, { dryRun: true, log: noop });
    expect(stats.find((s) => s.entity === 'mem')!.migrated).toBe(1);

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe('acme.com:code-gen:app-user:dryrun'); // unchanged
    expect(after.urnNormalizedAt).toBeNull();
  });
});
