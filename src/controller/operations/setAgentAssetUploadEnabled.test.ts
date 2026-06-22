/**
 * Integration test (US1 / spec FR-020): the setAgentAssetUploadEnabled
 * controller op toggles the canonical tool key in the agent's App
 * row's agentTools allowlist. Runs against the real DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import {
  setAgentAssetUploadEnabled,
  SetAssetEnabledError,
} from './setAgentAssetUploadEnabled.js';

let org: { id: string; urn: string };
let admin: { id: string };
let nonAdmin: { id: string };
let agent: { id: string; urn: string };
let app: { id: string };

const isAdminFor = async (_db: unknown, userId: string, _orgId: string) =>
  userId === admin.id;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9301, githubUsername: 'asset-admin', roles: ['ADMIN'] },
  });
  nonAdmin = await db.user.create({
    data: { githubId: 9302, githubUsername: 'asset-user', roles: ['READER'] },
  });
  // Agent and the App that backs it share a URN, per the convention
  // setAgentAssetUploadEnabled enforces.
  const sharedUrn = `${org.urn}:buno`;
  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: sharedUrn,
      name: 'Buno',
      type: 'CHATBOT',
      surfaces: ['api'],
    },
  });
  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: sharedUrn,
      name: 'Buno App',
    },
  });
});

describe('setAgentAssetUploadEnabled', () => {
  it('adds asset:upload to agentTools when enabling', async () => {
    const updated = await setAgentAssetUploadEnabled(
      db,
      { userId: admin.id },
      { agentUrn: agent.urn, enabled: true },
      isAdminFor,
    );
    expect(updated.agentTools).toContain('asset:upload');
  });

  it('removes asset:upload from agentTools when disabling', async () => {
    await db.app.update({
      where: { id: app.id },
      data: { agentTools: ['asset:upload', 'hadron_find_nodes'] },
    });
    const updated = await setAgentAssetUploadEnabled(
      db,
      { userId: admin.id },
      { agentUrn: agent.urn, enabled: false },
      isAdminFor,
    );
    expect(updated.agentTools).not.toContain('asset:upload');
    expect(updated.agentTools).toContain('hadron_find_nodes');
  });

  it('is a no-op when already in the desired state', async () => {
    await db.app.update({
      where: { id: app.id },
      data: { agentTools: ['asset:upload'] },
    });
    const updated = await setAgentAssetUploadEnabled(
      db,
      { userId: admin.id },
      { agentUrn: agent.urn, enabled: true },
      isAdminFor,
    );
    expect(updated.agentTools).toEqual(['asset:upload']);
  });

  it('rejects non-admin callers with PERMISSION_DENIED', async () => {
    await expect(
      setAgentAssetUploadEnabled(
        db,
        { userId: nonAdmin.id },
        { agentUrn: agent.urn, enabled: true },
        isAdminFor,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects unknown agent with NOT_FOUND', async () => {
    await expect(
      setAgentAssetUploadEnabled(
        db,
        { userId: admin.id },
        { agentUrn: 'asset-org:does-not-exist', enabled: true },
        isAdminFor,
      ),
    ).rejects.toThrow(SetAssetEnabledError);
  });

  // 007-entity-id-or-urn FR-012: agentUrn input accepts ID or URN.
  it('accepts a raw agent ID as agentUrn input', async () => {
    const updated = await setAgentAssetUploadEnabled(
      db,
      { userId: admin.id },
      { agentUrn: agent.id, enabled: true },
      isAdminFor,
    );
    expect(updated.agentTools).toContain('asset:upload');
  });

  it('accepts a prefixed URN (urn:agent:...) as agentUrn input', async () => {
    const updated = await setAgentAssetUploadEnabled(
      db,
      { userId: admin.id },
      { agentUrn: `urn:agent:${agent.urn}`, enabled: true },
      isAdminFor,
    );
    expect(updated.agentTools).toContain('asset:upload');
  });

  it('rejects when the agent has no matching App', async () => {
    const orphanUrn = `${org.urn}:orphan`;
    await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: orphanUrn,
        name: 'Orphan',
        type: 'CHATBOT',
        surfaces: ['api'],
      },
    });
    await expect(
      setAgentAssetUploadEnabled(
        db,
        { userId: admin.id },
        { agentUrn: orphanUrn, enabled: true },
        isAdminFor,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
