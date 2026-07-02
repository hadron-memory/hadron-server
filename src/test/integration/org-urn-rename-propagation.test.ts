/**
 * propagateOrgUrnRename — the denormalized org-slug prefix rewrite that keeps
 * Memory/Agent/App URNs in step with an org rename (issue #337).
 *
 * Pins the drift-heal fix: the cascade scopes rows by `organization_id` and
 * strips whatever prefix precedes the first colon, rather than prefix-matching
 * the org's *current* URN. A row whose prefix has already diverged from the
 * live org URN (e.g. a rename that predated the cascade, or a direct DB edit)
 * must still be pulled back into line — the earlier prefix-matched version
 * stranded such rows forever.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { propagateOrgUrnRename } from '../../lib/org/propagateOrgUrnRename.js';

describe('propagateOrgUrnRename', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  it('rewrites in-step children AND heals a drifted-prefix child (FK-scoped)', async () => {
    // Org whose live URN is `holger-pers`; renaming to `holger-pers2`.
    const org = await db.organization.create({
      data: { id: generateId(), name: 'holger', urn: 'holger-pers' },
    });

    // Memory A: prefix in step with the org's live URN (canonical `::`).
    const memInStep = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'holger-pers::in-step',
        name: 'in-step',
        class: 'knowledge',
      },
    });

    // Memory B: prefix already DRIFTED from the org's live URN — this is the
    // `personal-<userId>` case a pre-cascade rename left behind.
    const memDrifted = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'personal-abc123::holgers-gear',
        name: 'holgers-gear',
        class: 'knowledge',
      },
    });

    // Legacy single-colon child (pre-021 form) must keep its single colon.
    const agentLegacy = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'holger-pers:my-agent',
        name: 'My Agent',
      },
    });

    await db.$transaction((tx) =>
      propagateOrgUrnRename(tx, org.id, 'holger-pers', 'holger-pers2'),
    );

    const a = await db.memory.findUniqueOrThrow({ where: { id: memInStep.id } });
    const b = await db.memory.findUniqueOrThrow({ where: { id: memDrifted.id } });
    const ag = await db.agent.findUniqueOrThrow({ where: { id: agentLegacy.id } });

    expect(a.urn).toBe('holger-pers2::in-step'); // in-step rewritten
    expect(b.urn).toBe('holger-pers2::holgers-gear'); // drifted row HEALED
    expect(ag.urn).toBe('holger-pers2:my-agent'); // legacy single-colon preserved
  });

  it('skips rows already at the target prefix (no needless write)', async () => {
    // xmin is the inserting/updating txn id — it changes iff the row is
    // physically rewritten, so it's a precise probe for "was this row touched".
    const xmin = async (id: string) =>
      (
        await db.$queryRaw<{ xmin: string }[]>`
          SELECT xmin::text AS xmin FROM memories WHERE id = ${id}
        `
      )[0]?.xmin;

    const org = await db.organization.create({
      data: { id: generateId(), name: 'x', urn: 'org-old' },
    });
    // Already at the target `org-new` prefix (e.g. a prior partial heal).
    const alreadyCorrect = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'org-new::correct',
        name: 'correct',
        class: 'knowledge',
      },
    });
    // Needs rewriting.
    const stale = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'org-old::stale',
        name: 'stale',
        class: 'knowledge',
      },
    });

    const correctBefore = await xmin(alreadyCorrect.id);
    const staleBefore = await xmin(stale.id);

    await db.$transaction((tx) => propagateOrgUrnRename(tx, org.id, 'org-old', 'org-new'));

    // Already-correct row untouched (same xmin); stale row rewritten (new xmin).
    expect(await xmin(alreadyCorrect.id)).toBe(correctBefore);
    expect(await xmin(stale.id)).not.toBe(staleBefore);

    const c = await db.memory.findUniqueOrThrow({ where: { id: alreadyCorrect.id } });
    const s = await db.memory.findUniqueOrThrow({ where: { id: stale.id } });
    expect(c.urn).toBe('org-new::correct');
    expect(s.urn).toBe('org-new::stale');
  });

  it('does not touch other orgs\' rows', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'a', urn: 'org-a' },
    });
    const other = await db.organization.create({
      data: { id: generateId(), name: 'b', urn: 'org-b' },
    });
    const otherMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: other.id,
        urn: 'org-b::keep',
        name: 'keep',
        class: 'knowledge',
      },
    });

    await db.$transaction((tx) => propagateOrgUrnRename(tx, org.id, 'org-a', 'org-a2'));

    const m = await db.memory.findUniqueOrThrow({ where: { id: otherMem.id } });
    expect(m.urn).toBe('org-b::keep');
  });
});
