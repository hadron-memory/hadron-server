/**
 * 033-rag-vector-retrieval Phase 8 polish T058 — h-validate surfaces
 * embedding-failure diagnosability.
 *
 * Pins: when a node's async embedding hits the attempts cap (transient
 * failure) OR lands on the permanent #206 encrypted-no-plaintext branch,
 * `embedding_failed_at` is stamped. h-validate now emits an
 * `[embed-failed] <urn> — <reason>` line so an empty vector index is
 * diagnosable from the validator's output (the operator-facing surface
 * for spec-033 sweep failures).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';

let orgUrn: string;
let memUrn: string;
let memId: string;
let adminId: string;

function adminAuth(): AuthContext {
  return { userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` };
}

beforeEach(async () => {
  await cleanDb(db);

  orgUrn = `pol-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  const admin = await db.user.create({
    data: { githubId: 9914, githubUsername: 'pol-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;

  memUrn = `${orgUrn}:polmem`;
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: memUrn,
      name: 'polmem',
      class: 'knowledge',
      vectorIndexEnabled: true,
    },
  });
  memId = mem.id;
});

afterAll(async () => {
  // No global state to reset.
});

async function validate(): Promise<string> {
  const srv = createTestableMcpServer(adminAuth());
  return srv.callToolText('h-validate', { memoryUrn: memUrn });
}

describe('Phase 8 T058 — h-validate surfaces embedding-failure diagnosability', () => {
  it('node with embeddingFailedAt set + an error message → [embed-failed] line in output', async () => {
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: memId,
        loc: 'failed-perm',
        name: 'failed-perm',
        abstract: 'an abstract',
        content: 'body',
        embeddingPendingAt: null,
        embeddingFailedAt: new Date(),
        embeddingError: 'encrypted-no-plaintext (#206)',
        embeddingAttempts: 0,
      },
    });

    const out = await validate();
    expect(out).toContain('[embed-failed]');
    expect(out).toContain('failed-perm');
    expect(out).toContain('encrypted-no-plaintext');
    expect(out).toContain('#206');
  });

  it('node with embeddingFailedAt set but no error message → falls back to "unknown"', async () => {
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: memId,
        loc: 'failed-blank',
        name: 'failed-blank',
        abstract: 'an abstract',
        content: 'body',
        embeddingFailedAt: new Date(),
        embeddingError: null,
        embeddingAttempts: 0,
      },
    });

    const out = await validate();
    expect(out).toContain('[embed-failed]');
    expect(out).toContain('failed-blank');
    expect(out).toContain('unknown');
  });

  it('node with embeddingFailedAt null → NO [embed-failed] line', async () => {
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: memId,
        loc: 'healthy',
        name: 'healthy',
        abstract: 'an abstract',
        content: 'body',
        embeddingFailedAt: null,
        embeddingError: null,
        embeddingAttempts: 0,
      },
    });

    const out = await validate();
    expect(out).not.toContain('[embed-failed]');
  });

  it('mixed memory: failed node + healthy node → only the failed one is flagged', async () => {
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: memId,
        loc: 'mix-bad',
        name: 'mix-bad',
        content: 'body',
        embeddingFailedAt: new Date(),
        embeddingError: 'rate-limit retry exhausted',
        embeddingAttempts: 5,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: memId,
        loc: 'mix-good',
        name: 'mix-good',
        content: 'body',
        embeddingFailedAt: null,
        embeddingAttempts: 0,
      },
    });

    const out = await validate();
    expect(out).toContain('[embed-failed]');
    expect(out).toContain('mix-bad');
    expect(out).toContain('rate-limit retry exhausted');
    // The healthy node MUST NOT be flagged.
    expect(out).not.toMatch(/\[embed-failed\][^\n]*mix-good/);
  });
});
