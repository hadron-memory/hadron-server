/**
 * #697 stored-alias-map resolution fallback — resolveMemoryRef / resolveAgentRef
 * / resolveAppRef redirect a LEGACY URN input to a row migrated to v2 via the
 * `legacyUrn` column, fail loudly on ambiguity, and stay inert pre-migration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolveMemoryRef } from './memoryRef.js';
import { resolveAgentRef } from './agentRef.js';
import { resolveAppRef } from './appRef.js';
import { MemoryNotFoundError } from '../asset/gate.js';
import { AgentNotFoundError, AppNotFoundError, AmbiguousLegacyUrnError } from './errors.js';

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'alias-org', urn: `alias-org-${generateId()}` },
  });
  orgId = org.id;
});

describe('#697 legacy-alias fallback', () => {
  it('redirects a legacy memory URN to the row migrated to v2 via legacyUrn', async () => {
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: 'neworg.com:notes', // the migrated v2 urn
        legacyUrn: 'oldorg.com:notes', // the pre-migration urn
        name: 'notes',
        class: 'knowledge',
      },
    });
    // A legacy reference normalizes to `oldorg.com:notes` → misses `urn`, hits `legacyUrn`.
    const out = await resolveMemoryRef(db, 'hrn:memory:oldorg.com::notes');
    expect(out).toEqual({ id: mem.id });
  });

  it('still resolves the primary urn directly when legacyUrn is null (inert pre-migration)', async () => {
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: 'oldorg.com:inert',
        name: 'inert',
        class: 'knowledge',
      },
    });
    const out = await resolveMemoryRef(db, 'hrn:memory:oldorg.com::inert');
    expect(out).toEqual({ id: mem.id });
  });

  it('throws AmbiguousLegacyUrnError when a legacy input matches >1 live row', async () => {
    for (const n of [1, 2]) {
      await db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgId,
          urn: `neworg.com:dup-${n}`,
          legacyUrn: 'oldorg.com:dup', // same legacy urn on two live rows
          name: `dup-${n}`,
          class: 'knowledge',
        },
      });
    }
    await expect(resolveMemoryRef(db, 'hrn:memory:oldorg.com::dup')).rejects.toBeInstanceOf(
      AmbiguousLegacyUrnError,
    );
  });

  it('does not match a SOFT-DELETED alias row (unless includeDeleted)', async () => {
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: 'neworg.com:gone',
        legacyUrn: 'oldorg.com:gone',
        name: 'gone',
        class: 'knowledge',
        deletedAt: new Date(),
      },
    });
    await expect(resolveMemoryRef(db, 'hrn:memory:oldorg.com::gone')).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  it('throws NotFound when a legacy input matches neither urn nor legacyUrn', async () => {
    await expect(resolveMemoryRef(db, 'hrn:memory:nothing.com::here')).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  it('redirects a legacy agent URN via legacyUrn', async () => {
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: 'neworg.com:helper',
        legacyUrn: 'oldorg.com:helper',
        name: 'helper',
      },
    });
    const out = await resolveAgentRef(db, 'hrn:agent:oldorg.com::helper');
    expect(out).toEqual({ id: agent.id });
    await expect(resolveAgentRef(db, 'hrn:agent:nothing.com::x')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it('redirects a legacy app URN via legacyUrn (active-row liveness)', async () => {
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: 'neworg.com:ops',
        legacyUrn: 'oldorg.com:ops',
        name: 'ops',
      },
    });
    const out = await resolveAppRef(db, 'hrn:app:oldorg.com::ops');
    expect(out).toEqual({ id: app.id });
    await expect(resolveAppRef(db, 'hrn:app:nothing.com::x')).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });
});
