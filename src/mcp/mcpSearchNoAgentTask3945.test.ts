/** #3945 (cor:api:050 recorded exception): MCP hadron_search stays at seven types and never returns a task. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { globalSearch } from '../lib/global-search/index.js';

describe('MCP hadron_search excludes agentTask (#3945)', () => {
  it('the tool\'s entityTypes enum carries the seven non-task values', () => {
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    expect(src).toContain("z.enum(['organization', 'memory', 'node', 'agent', 'app', 'aiServiceConfig', 'user'])");
    expect(src).not.toMatch(/z\.enum\(\[[^\]]*agentTask/);
  });

  it('an engine call built the MCP way (no taskReadGate) returns no task, unrestricted or named', async () => {
    await cleanDb(db);
    const user = await db.user.create({ data: { id: generateId(), githubId: 99_390, githubUsername: `m-${generateId()}`, roles: ['READER'] } });
    const org = await db.organization.create({ data: { id: generateId(), name: 'm-org', urn: `m-org-${generateId()}.com` } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
    await db.agentTask.create({ data: { id: generateId(), appId: app.id, title: 'mcp invisible', ownerUserId: user.id } });
    const p = { viewerUserId: null, isPlatformAdmin: true, accessibleMemoryIds: null, orgIds: null, viewerOrgIds: [] };
    for (const entityTypes of [null, ['agentTask' as const]]) {
      const r = await globalSearch(db, { query: 'mcp invisible', entityTypes }, p);
      expect(r.hits.filter((h) => h.entityType === 'agentTask')).toEqual([]);
    }
  });
});
