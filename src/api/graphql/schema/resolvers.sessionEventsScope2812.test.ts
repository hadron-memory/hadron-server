/** #2812: isolate Session.events reauthorization from already-filtered query parents. */
import { beforeEach, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

beforeEach(async () => { await cleanDb(db); });

it('#2812 denies a private-bound parent even when its unbound event passes the event-memory gate', async () => {
  const owner = await db.user.create({ data: { handle: `owner-${generateId()}` } });
  const member = await db.user.create({ data: { handle: `member-${generateId()}` } });
  const org = await db.organization.create({ data: { name: 'Nested scope', urn: `nested-${generateId()}.test` } });
  await db.orgMember.createMany({ data: [owner, member].map(user => ({
    organizationId: org.id, userId: user.id, role: 'READER' as const,
  })) });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Nested', urn: `${org.urn}:app` } });
  const memory = await db.memory.create({ data: {
    organizationId: org.id, userId: owner.id, name: 'Private', urn: `${org.urn}:private`, class: 'private',
  } });
  const parent = await db.session.create({ data: {
    appId: app.id, userId: owner.id, memoryId: memory.id,
  }, select: { id: true } });
  // memoryId null is intentional: this event survives the independent event-memory
  // filter, so only the nested SESSION guard can withhold it from the non-owner.
  const event = await db.usageEvent.create({ data: {
    sessionId: parent.id, memoryId: null, type: 'session-summary', nodeLoc: 'nested-scope-witness',
  } });
  expect(await db.usageEvent.count({ where: { sessionId: parent.id, memoryId: null } })).toBe(1);
  const context = (userId: string): Context => ({ db, userId, roles: ['READER'] });
  const nested = (resolvers.Session as any).events;
  expect(nested).toBeTypeOf('function');
  // Invoke the actual nested resolver directly: no Query.session / Query.sessions
  // parent selection runs first and masks deletion of its own recheck.
  const allowed = await nested(parent, {}, context(owner.id));
  expect(allowed.map((row: { id: string }) => row.id)).toEqual([event.id]);
  expect(await nested(parent, {}, context(member.id))).toEqual([]);
});
