/**
 * Validation tests for publishAgentImport. Per spec 008-agent-installation
 * FR-005 + research.md §R-8 + the "Validation" section in
 * contracts/agent-app-graphql.md.
 *
 * Covers:
 *   - Self-import rejection
 *   - 2-level rejection (1-level enforcement, R-8 cycle protection)
 *   - Missing AgentOrgGrant
 *   - Position collision
 *   - Valid create
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import {
  cleanDb,
  createDbAgentImport,
  createDbAgentOrgGrant,
} from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import {
  publishAgentImport,
  SelfImportError,
  MultiLevelImportError,
  MissingGrantError,
  PositionConflictError,
} from './publishAgentImport.js';

let orgId: string;
let suiteId: string;
let calendarId: string;
let notesId: string;
let unrelatedId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'pai-org', urn: 'pai-org' },
  });
  orgId = org.id;
  // Suite is the parent ("Productivity Suite"). Calendar + Notes are deps.
  // Unrelated is a sanity-check Agent for self-import.
  const make = async (slug: string) => {
    const a = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:${slug}`,
        name: slug,
      },
    });
    return a.id;
  };
  suiteId = await make('suite');
  calendarId = await make('calendar');
  notesId = await make('notes');
  unrelatedId = await make('unrelated');

  // Suite's owning org has an active grant for both deps (the spec's
  // "Builder bundles agents they're licensed to bundle" requirement).
  await createDbAgentOrgGrant(db, orgId, calendarId);
  await createDbAgentOrgGrant(db, orgId, notesId);
});

describe('publishAgentImport — validation', () => {
  it('rejects self-import with SelfImportError', async () => {
    await expect(
      publishAgentImport(db, {
        parentAgentId: suiteId,
        importedAgentId: suiteId,
        position: 100,
      }),
    ).rejects.toBeInstanceOf(SelfImportError);
  });

  it('rejects 2-level imports with MultiLevelImportError (R-8)', async () => {
    // Calendar imports Unrelated → Calendar is a parent. Now try to make
    // Suite import Calendar → Calendar is also a child of Suite, which means
    // Suite → Calendar → Unrelated would be a 2-level tree. Reject.
    // The seed AgentImport needs an AgentOrgGrant FK; provision it.
    await createDbAgentOrgGrant(db, orgId, unrelatedId);
    await createDbAgentImport(db, calendarId, unrelatedId, { position: 100 });
    await expect(
      publishAgentImport(db, {
        parentAgentId: suiteId,
        importedAgentId: calendarId,
        position: 100,
      }),
    ).rejects.toBeInstanceOf(MultiLevelImportError);
  });

  it('rejects when no active AgentOrgGrant exists for the parent\'s org × imported Agent', async () => {
    // Build a fresh Agent in a different org with NO grant for Calendar.
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    const externalSuite = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        urn: `${otherOrg.urn}:other-suite`,
        name: 'other-suite',
      },
    });
    await expect(
      publishAgentImport(db, {
        parentAgentId: externalSuite.id,
        importedAgentId: calendarId,
        position: 100,
      }),
    ).rejects.toBeInstanceOf(MissingGrantError);
  });

  it('rejects when the AgentOrgGrant is revoked (lifecycle predicate)', async () => {
    // Same-org parent + dep, but the grant is revoked.
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId, agentId: calendarId } },
      data: { revokedAt: new Date() },
    });
    await expect(
      publishAgentImport(db, {
        parentAgentId: suiteId,
        importedAgentId: calendarId,
        position: 100,
      }),
    ).rejects.toBeInstanceOf(MissingGrantError);
  });

  it('rejects two imports at the same (parent, position) with PositionConflictError', async () => {
    await publishAgentImport(db, {
      parentAgentId: suiteId,
      importedAgentId: calendarId,
      position: 100,
    });
    await expect(
      publishAgentImport(db, {
        parentAgentId: suiteId,
        importedAgentId: notesId,
        position: 100, // collision with Calendar's slot
      }),
    ).rejects.toBeInstanceOf(PositionConflictError);
  });

  it('creates the import row when all validation passes', async () => {
    const imp = await publishAgentImport(db, {
      parentAgentId: suiteId,
      importedAgentId: calendarId,
      position: 100,
      required: false,
    });
    expect(imp.parentAgentId).toBe(suiteId);
    expect(imp.importedAgentId).toBe(calendarId);
    expect(imp.position).toBe(100);
    expect(imp.required).toBe(false);
    expect(imp.agentOrgGrantOrgId).toBe(orgId);
    expect(imp.agentOrgGrantAgentId).toBe(calendarId);
  });
});
