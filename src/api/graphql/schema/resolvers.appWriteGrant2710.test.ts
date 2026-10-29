/**
 * #2710: an App's write grant never covers an Agent's system memory (Holger, 2026-10-28, ruling D1, option A;
 * hrn:node:hadronmemory.com:specs:cor:agt:010:01). The Agent's system memory, its boot-prompt source included, is
 * written only by whoever manages the Agent (hrn:node:hadronmemory.com:specs:cor:agt:040:11).
 *
 * Red first. On main `grantTargetRefusal` admits a `class = system` memory held by the App's org, so the set below
 * succeeds and a userless run writes `boot:source`. Both halves of the ruling are pinned: making the grant is refused,
 * and a grant that already exists (written before the rule) authorizes no write, with no data migration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { resolvers } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
beforeEach(async () => { await cleanDb(db); });

const M = resolvers.Mutation as any;
const PREFIX = 'boot';
const REGISTER = 'hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:authorizations';

/** A manager of both the App and the Agent: an org ADMIN who owns the App, so every other gate passes. */
async function fixture() {
  const org = await db.organization.create({ data: { name: 'Grant Org', urn: 'grant2710.test' } });
  const mgr = await db.user.create({ data: { handle: 'grant2710-mgr' } });
  await db.orgMember.create({ data: { userId: mgr.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Grant App', urn: 'grant2710.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: mgr.id, role: 'owner' } });
  const system = await db.memory.create({ data: { name: 'iris-system', urn: 'grant2710.test:iris-system', class: 'system', organizationId: org.id } as never });
  await db.agent.create({ data: { name: 'Iris', urn: 'grant2710.test:iris', organizationId: org.id, systemMemoryId: system.id } as never });
  const dest = await db.memory.create({ data: { name: 'dest', urn: 'grant2710.test:dest', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
  const ctx = { db, userId: mgr.id, roles: [] as never[] };
  const runCtx = () => ({ db, ...runAuthContext({ id: generateId(), appId: app.id, userId: null, organizationId: org.id }) }) as never;
  return { org, mgr, app, system, dest, ctx, runCtx };
}

const create = (ctx: unknown, memoryId: string, loc: string) =>
  writeNodeCore({ memoryId, loc, name: loc.split(':').pop()!, nodeType: 'record', content: 'You are {{worker.name}}.' } as never, ctx as never, 'create');

describe('#2710 a write grant never covers a class=system memory', () => {
  it('setting a grant on an Agent system memory is refused, and nothing is recorded', async () => {
    const f = await fixture();
    await expect(M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.system.id, prefix: PREFIX, registerNodeUrn: REGISTER }, f.ctx))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.appMemoryWriteGrant.count({ where: { appId: f.app.id } })).toBe(0);
    expect(await db.appMemoryWriteGrantEvent.count({ where: { appId: f.app.id } })).toBe(0);
  });

  it('a grant row that already exists on one authorizes no userless run write (boot:source stays unwritten)', async () => {
    const f = await fixture();
    // A row as it could have been made before the rule: the door now refuses it, so write it directly.
    await db.appMemoryWriteGrant.create({ data: { appId: f.app.id, memoryId: f.system.id, prefix: PREFIX, registerNodeUrn: REGISTER, grantedBy: f.mgr.id } });
    await expect(create(f.runCtx(), f.system.id, 'boot:source')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.node.count({ where: { memoryId: f.system.id } })).toBe(0);
  });

  it('CONTROL: the same manager and run still set and use a grant on a shared memory of the org', async () => {
    const f = await fixture();
    await M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.dest.id, prefix: PREFIX, registerNodeUrn: REGISTER }, f.ctx);
    await create(f.runCtx(), f.dest.id, 'boot:source');
    expect(await db.node.count({ where: { memoryId: f.dest.id } })).toBe(1);
  });
});
