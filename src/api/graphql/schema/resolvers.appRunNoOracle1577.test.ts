/**
 * #1577 — GraphQL `appRun(ref:)` is no existence oracle: a run the caller may
 * not read answers exactly like a run that does not exist (null), never
 * Forbidden. The platform's concealment posture (#1316, #1381; Ada #5919),
 * matching MCP `hadron_get_run`. Only an authorization denial is concealed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let reader: { id: string };
let outsider: { id: string };
let app: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const appRun = (userId: string, ref: string) =>
  (resolvers.Query as any).appRun({}, { ref }, ctx(userId));

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'no', urn: `no-${t}` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'no-o', urn: `no-o-${t}` } });
  reader = await db.user.create({ data: { id: generateId(), githubId: 15770, githubUsername: `no-r-${t}`, handle: `no-r-${t}` } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 15771, githubUsername: `no-x-${t}`, handle: `no-x-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: outsider.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Flow', urn: `${org.urn}:flow` } });
});

const run = () => db.appRun.create({
  data: { id: generateId(), organizationId: org.id, appId: app.id, triggerKind: 'MANUAL', entryNodeUrn: `hrn:node:${org.urn}:f:e`, status: 'COMPLETED' } as never,
});

describe('#1577 — appRun(ref:) conceals an unreadable run', () => {
  it('an unreadable run returns null, exactly like a missing one (no Forbidden)', async () => {
    const r = await run();
    await expect(appRun(outsider.id, r.id)).resolves.toBeNull();
    await expect(appRun(outsider.id, generateId())).resolves.toBeNull();
  });

  it('control: an org READER still reads the run', async () => {
    const r = await run();
    await expect(appRun(reader.id, r.id)).resolves.toMatchObject({ id: r.id });
  });

  it('only an authorization denial is concealed; any other error still surfaces', async () => {
    const r = await run();
    const spy = vi.spyOn(db.orgMember, 'findFirst').mockRejectedValueOnce(new Error('db down'));
    try {
      await expect(appRun(outsider.id, r.id)).rejects.toThrow('db down');
    } finally {
      spy.mockRestore();
    }
  });
});
