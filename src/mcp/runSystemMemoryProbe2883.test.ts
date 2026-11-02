/**
 * #2883 probe (Xanthos condition, team chat #66535): does the shared read gate admit a USERLESS run of an org App to
 * the system memory of a same-org, org-owned, licensed Agent installed in that App (the product-team-app /
 * saas-product-manager shape of run 01a19aed8d5574109f4e9e20486c0d23)? Records main's behaviour; changes nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let app: { id: string };
let org: { id: string };
let first: { id: string; systemMemoryId: string };
let second: { id: string; systemMemoryId: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Probe Org', urn: `probe-${generateId().toLowerCase()}.example` } });
  const admin = await db.user.create({ data: { id: generateId(), name: 'admin', handle: `admin-${generateId().slice(-6).toLowerCase()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const ctx = { db, userId: admin.id, roles: ['READER'] } as unknown as Context;
  first = await M.createAgent({}, { orgId: org.id, name: 'First' }, ctx);
  second = await M.createAgent({}, { orgId: org.id, name: 'Second' }, ctx);
  ({ app } = await createDbAppWithKey(db, 'probe-app', org.id));
  await createDbAppAgent(db, app.id, first.id);
  await new Promise((r) => setTimeout(r, 5)); // distinct AppAgent.createdAt: install order is the fold's order
  await createDbAppAgent(db, app.id, second.id);
});

const userlessRun = (): AuthContext => ({ appId: app.id, organizationId: org.id, roles: [], clientId: `run:${generateId()}` } as AuthContext);

describe('#2883 probe: userless run reach into installed same-org Agents\' system memories (main)', () => {
  it('admits the FIRST-installed Agent\'s system memory and refuses every later one', async () => {
    expect(await canReadMemory(db, userlessRun(), first.systemMemoryId)).toBe(true);
    expect(await canReadMemory(db, userlessRun(), second.systemMemoryId)).toBe(false);
  });
});
