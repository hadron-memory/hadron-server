/**
 * Test-fixture hygiene for `chk_memory_class_app_id` (Xan on #2219, 6326582616). Two fixtures drop the CHECK to
 * stage legacy rows and re-add it afterwards; each re-added a STALE shape with no install-memory arm (#2064), so every
 * later file in the same vitest worker that created an install memory failed with 23514. The restore now comes from
 * prisma/post-push.sql itself, so it cannot drift from the real definition.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';
import { CHK_MEMORY_CLASS_APP_ID_SQL, restoreChkMemoryClassAppId } from './memoryClassCheck.js';

const FIXTURES = ['src/test/integration/008-personal-memory.test.ts', 'src/test/migrations/agent-subscription-backfill.test.ts'];

describe('restoring chk_memory_class_app_id in tests', () => {
  beforeEach(async () => { await cleanDb(db); });

  it('the restore is exactly prisma/post-push.sql\'s definition, install-memory arm included', () => {
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain(CHK_MEMORY_CLASS_APP_ID_SQL);
    expect(CHK_MEMORY_CLASS_APP_ID_SQL).toMatch(/class = 'system' AND app_id IS NOT NULL AND is_install_memory = true/);
  });

  it('no fixture re-adds the CHECK inline: they all restore through the shared helper', () => {
    for (const file of FIXTURES) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/ADD CONSTRAINT chk_memory_class_app_id/);
      expect(src, file).toMatch(/restoreChkMemoryClassAppId\(/);
    }
  });

  it('after a drop and restore, an install memory inserts and a malformed system row is refused', async () => {
    await restoreChkMemoryClassAppId((sql) => db.$executeRawUnsafe(sql));
    const org = await db.organization.create({ data: { id: generateId(), name: 'mc', urn: `mc-${generateId().toLowerCase()}.example` } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'A', urn: `${org.urn}:a`, organizationId: org.id } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
    await expect(db.memory.create({ data: {
      id: generateId(), class: 'system', name: 'install', urn: `${org.urn}:install`, organizationId: org.id, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true,
    } })).resolves.toBeTruthy();
    await expect(db.memory.create({ data: {
      id: generateId(), class: 'system', name: 'bad', urn: `${org.urn}:bad`, organizationId: org.id, appId: app.id, isInstallMemory: false,
    } })).rejects.toThrow(/chk_memory_class_app_id/);
  });
});
