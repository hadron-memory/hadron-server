/**
 * Integration test (US2 / FR-008): beginAssetUpload validates the
 * agent + the App's asset-upload gate, validates limits, and mints a
 * presigned PUT URL. R2 client is mocked so the test runs without a
 * MinIO instance; an end-to-end MinIO test lives separately.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import {
  beginAssetUpload,
  beginAssetUploadV2,
  AssetUploadError,
} from './beginAssetUpload.js';

vi.mock('../../integrations/r2/client.js', () => ({
  mintPutUrl: vi.fn().mockResolvedValue('https://r2.example/presigned-put'),
  headObject: vi.fn(),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  getObjectStoreBucket: vi.fn().mockReturnValue('test-bucket'),
}));

let org: { id: string; urn: string };
let user: { id: string };
let agent: { id: string; urn: string };
let app: { id: string };
let memory: { id: string; urn: string };

const resolveTargetMemoryId = vi.fn(async () => ({ memoryId: memory.id }));

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  user = await db.user.create({
    data: { githubId: 9401, githubUsername: 'asset-user', roles: ['READER'] },
  });
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
      agentTools: ['asset:upload'], // tool enabled by default
      // 008: App→Agent direct FK; required for personal-memory app_id pivot.
      appAgents: { create: { agentId: agent.id } },
    },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:buno:user:${generateId()}`,
      name: 'user-memory',
      visibility: 'ORGANIZATION',
    },
  });
  resolveTargetMemoryId.mockClear();
  resolveTargetMemoryId.mockResolvedValue({ memoryId: memory.id });
});

describe('beginAssetUpload', () => {
  it('mints a presigned PUT URL for a valid USER intent upload', async () => {
    const ticket = await beginAssetUpload(
      db,
      { userId: user.id },
      {
        agentUrn: agent.urn,
        filename: 'business-plan.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        uploadIntent: 'USER',
      },
      resolveTargetMemoryId,
    );
    expect(ticket.putUrl).toBe('https://r2.example/presigned-put');
    expect(ticket.uploadId).toBeTruthy();
    expect(ticket.storageKey).toMatch(/^asset-org\//);
    expect(ticket.storageKey).toMatch(/\.pdf$/);
    expect(ticket.allowedMimeType).toBe('application/pdf');
  });

  // 007-entity-id-or-urn FR-012: v1 agentUrn input accepts ID or URN.
  it('accepts a raw agent ID as agentUrn input', async () => {
    const ticket = await beginAssetUpload(
      db,
      { userId: user.id },
      {
        agentUrn: agent.id,
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        uploadIntent: 'USER',
      },
      resolveTargetMemoryId,
    );
    expect(ticket.putUrl).toBe('https://r2.example/presigned-put');
    expect(ticket.uploadId).toBeTruthy();
  });

  it('accepts a prefixed URN (urn:agent:...) as agentUrn input', async () => {
    const ticket = await beginAssetUpload(
      db,
      { userId: user.id },
      {
        agentUrn: `urn:agent:${agent.urn}`,
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        uploadIntent: 'USER',
      },
      resolveTargetMemoryId,
    );
    expect(ticket.putUrl).toBe('https://r2.example/presigned-put');
    expect(ticket.uploadId).toBeTruthy();
  });

  it('rejects when the App does not have asset:upload enabled', async () => {
    await db.app.update({
      where: { id: app.id },
      data: { agentTools: [] },
    });
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id },
        {
          agentUrn: agent.urn,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED' });
  });

  it('rejects unknown agent with NOT_FOUND', async () => {
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id },
        {
          agentUrn: 'asset-org:unknown',
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects oversized files with SIZE_EXCEEDED', async () => {
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id },
        {
          agentUrn: agent.urn,
          filename: 'huge.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 5_000_000_000, // 5 GB
          uploadIntent: 'USER',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'SIZE_EXCEEDED' });
  });

  it('rejects disallowed MIME types with MIME_NOT_ALLOWED', async () => {
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id },
        {
          agentUrn: agent.urn,
          filename: 'malware.exe',
          mimeType: 'application/x-msdownload',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'MIME_NOT_ALLOWED' });
  });

  it('AGENT_REQUEST without uploadRequestId is INVALID_INPUT', async () => {
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id },
        {
          agentUrn: agent.urn,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'AGENT_REQUEST',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects callers from a different org with PERMISSION_DENIED when an appId is supplied', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    const otherApp = await db.app.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        urn: 'other-org:other-app',
        name: 'Other App',
      },
    });
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id, appId: otherApp.id },
        {
          agentUrn: agent.urn,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  // 006-asset-upload-redesign FR-009: enforce per-Memory acceptance
  // gate on v1 paths too. A v1 caller targeting a memory whose
  // acceptsUploads=false must be rejected.
  it('rejects v1 path when target memory acceptsUploads=false', async () => {
    await db.memory.update({
      where: { id: memory.id },
      data: { acceptsUploads: false },
    });
    await expect(
      beginAssetUpload(
        db,
        { userId: user.id },
        {
          agentUrn: agent.urn,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_ACCEPTING_UPLOADS' });
  });
});

// ──────────────────────────────────────────────────────────────────────
// v2 (spec 006-asset-upload-redesign): memory-addressed begin.
// ──────────────────────────────────────────────────────────────────────

describe('beginAssetUploadV2', () => {
  // For v2 tests we want a memory the caller has write access to.
  // Personal-class with userId set hits the strict-ownership branch
  // in canWriteToMemory and accepts the JWT-style caller (no appId).
  let v2Memory: { id: string; urn: string };

  beforeEach(async () => {
    v2Memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:v2mem:${generateId()}`,
        name: 'v2-personal-memory',
        class: 'personal',
        visibility: null,
        userId: user.id,
        // 008: chk_memory_class_app_id requires app_id for personal-class.
        appId: app.id,
        // 023 FR-004/FR-032: chk_memory_personal_agent_id requires the
        // (App, Agent, User) scope to be complete.
        userMemoryOfAgentId: agent.id,
      },
    });
  });

  it('mints a presigned PUT URL for a valid v2 USER intent upload (input by ID)', async () => {
    const ticket = await beginAssetUploadV2(
      db,
      { userId: user.id },
      {
        memoryId: v2Memory.id,
        filename: 'recipe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        uploadIntent: 'USER',
      },
    );
    expect(ticket.putUrl).toBe('https://r2.example/presigned-put');
    expect(ticket.uploadId).toBeTruthy();
    expect(ticket.storageKey).toMatch(/\.pdf$/);
    expect(ticket.allowedMimeType).toBe('application/pdf');
  });

  // 007-entity-id-or-urn: paired URN-input case asserts the operation
  // accepts the memory's URN identically to its ID. The storage key
  // resolves to the same memory regardless of input shape.
  it('mints a presigned PUT URL for a valid v2 USER intent upload (input by URN)', async () => {
    const ticket = await beginAssetUploadV2(
      db,
      { userId: user.id },
      {
        memoryId: v2Memory.urn,
        filename: 'recipe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        uploadIntent: 'USER',
      },
    );
    expect(ticket.putUrl).toBe('https://r2.example/presigned-put');
    expect(ticket.uploadId).toBeTruthy();
    expect(ticket.storageKey).toMatch(/\.pdf$/);
    expect(ticket.allowedMimeType).toBe('application/pdf');
  });

  it('mints a presigned PUT URL for a valid v2 USER intent upload (input by prefixed URN)', async () => {
    const ticket = await beginAssetUploadV2(
      db,
      { userId: user.id },
      {
        memoryId: `urn:memory:${v2Memory.urn}`,
        filename: 'recipe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        uploadIntent: 'USER',
      },
    );
    expect(ticket.putUrl).toBe('https://r2.example/presigned-put');
    expect(ticket.uploadId).toBeTruthy();
  });

  it('rejects unknown memoryId with NOT_FOUND', async () => {
    // 32-char hex — ID-shape, bypasses the spec-022 qualification check
    // and goes to DB lookup, which misses → NOT_FOUND.
    await expect(
      beginAssetUploadV2(
        db,
        { userId: user.id },
        {
          memoryId: '0123456789abcdef0123456789abcdef',
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects MEMORY_NOT_ACCEPTING_UPLOADS when memory has acceptsUploads=false', async () => {
    await db.memory.update({
      where: { id: v2Memory.id },
      data: { acceptsUploads: false },
    });
    await expect(
      beginAssetUploadV2(
        db,
        { userId: user.id },
        {
          memoryId: v2Memory.id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
      ),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_ACCEPTING_UPLOADS' });
  });

  it('rejects PERMISSION_DENIED when caller is not the personal-memory owner', async () => {
    const otherUser = await db.user.create({
      data: { githubId: 9402, githubUsername: 'asset-other', roles: ['READER'] },
    });
    await expect(
      beginAssetUploadV2(
        db,
        { userId: otherUser.id },
        {
          memoryId: v2Memory.id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects oversized files with SIZE_EXCEEDED', async () => {
    await expect(
      beginAssetUploadV2(
        db,
        { userId: user.id },
        {
          memoryId: v2Memory.id,
          filename: 'huge.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 5_000_000_000,
          uploadIntent: 'USER',
        },
      ),
    ).rejects.toMatchObject({ code: 'SIZE_EXCEEDED' });
  });

  it('rejects disallowed MIME types with MIME_NOT_ALLOWED', async () => {
    await expect(
      beginAssetUploadV2(
        db,
        { userId: user.id },
        {
          memoryId: v2Memory.id,
          filename: 'malware.exe',
          mimeType: 'application/x-msdownload',
          sizeBytes: 1024,
          uploadIntent: 'USER',
        },
      ),
    ).rejects.toMatchObject({ code: 'MIME_NOT_ALLOWED' });
  });

  it('AGENT_REQUEST without uploadRequestId is INVALID_INPUT', async () => {
    await expect(
      beginAssetUploadV2(
        db,
        { userId: user.id },
        {
          memoryId: v2Memory.id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadIntent: 'AGENT_REQUEST',
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
