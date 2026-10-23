/** #2245 (R170.6): `agent_clone_audits` is append-only and names exactly one target. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

const row = (patch: Record<string, unknown> = {}) => ({
  id: generateId(), sourceAgentId: 's', newAgentId: 'n', targetOrgId: 'o',
  nodeCount: 1, edgeCount: 0, skippedEdgeCount: 0, importCount: 0, linkCount: 0, ...patch,
});

beforeEach(async () => { await cleanDb(db); });

describe('agent_clone_audits', () => {
  it('accepts an org target and keeps ids without foreign keys', async () => {
    await expect(db.agentCloneAudit.create({ data: row() })).resolves.toBeTruthy();
  });
  it('refuses no target and two targets', async () => {
    await expect(db.agentCloneAudit.create({ data: row({ targetOrgId: null }) })).rejects.toThrow();
    await expect(db.agentCloneAudit.create({ data: row({ targetUserId: 'u' }) })).rejects.toThrow();
  });
  it('is append-only', async () => {
    const r = await db.agentCloneAudit.create({ data: row() });
    await expect(db.agentCloneAudit.update({ where: { id: r.id }, data: { nodeCount: 9 } })).rejects.toThrow(/append-only/);
    await expect(db.agentCloneAudit.delete({ where: { id: r.id } })).rejects.toThrow(/append-only/);
  });
});
