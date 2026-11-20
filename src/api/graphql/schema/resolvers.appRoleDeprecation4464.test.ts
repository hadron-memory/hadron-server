/**
 * hadron-server#4464 — App role deprecation, stage 1 (red-first pins).
 *
 * The App's own `role` is removed in stages (Holger's 2026-11-18 ruling,
 * cli#2515 option 2). Stage 1 is server-side only:
 *
 *  - `createApp` / `updateApp` still ACCEPT `role` but ignore it — a caller
 *    sending it succeeds with no behavior change, and nothing persists the
 *    caller's value;
 *  - `App.role` stays in the schema and returns the constant READER whatever
 *    the row stores (the stored column and its legacy values are untouched
 *    until the last stage);
 *  - the SDL changes only by `@deprecated` on exactly three places: the
 *    `App.role` field and the `role` arg of both mutations.
 *
 * Red on main (verified at 877597e99 before the fix): the create leg persists
 * the caller's value (resolvers.mutation.app.ts `role ?? 'READER'`), the
 * update leg writes it, and with no `App.role` type resolver the default
 * resolver returns the stored row value — so a stored-OWNER app reads OWNER.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs, APP_ROLE_DEPRECATION_NOTICE } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(over: Partial<Context> = {}): Context {
  return { db, ...over };
}

let ownerId: string;
let agentId: string;

/**
 * `App.role` through the type resolver, the way the GraphQL layer would call
 * it. Cast because the property only exists once stage 1 adds it — at main
 * this returns undefined, which is exactly the red these pins describe.
 */
const roleOf = (app: unknown): unknown =>
  (resolvers.App as unknown as Record<string, ((a: unknown) => unknown) | undefined>).role?.(app);

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({
    data: { id: generateId(), name: 'App Owner', handle: 'appowner', roles: ['READER'] },
  });
  ownerId = owner.id;
  // A publisher org with a PUBLIC agent, the minimum createApp prerequisite.
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Publisher', urn: `publisher-${generateId()}` },
  });
  const sys = await db.memory.create({
    data: {
      id: generateId(), class: 'system', name: 'GA System', urn: `${org.urn}:ga-system`,
      organizationId: org.id, acceptsUploads: false,
    },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(), name: 'Gmail Agent', urn: `${org.urn}:gmail-agent`,
      organizationId: org.id, visibility: 'PUBLIC', systemMemoryId: sys.id,
    },
  });
  agentId = agent.id;
});

describe('#4464 stage 1 — createApp/updateApp accept `role` and ignore it', () => {
  it('createApp WITH a role input succeeds and changes nothing: the stored column keeps READER', async () => {
    const app = await resolvers.Mutation.createApp(
      {},
      { agentRef: agentId, name: 'Deprecation Pin', role: 'OWNER' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const row = await db.app.findUnique({ where: { id: app.id }, select: { role: true } });
    // Red on main: the create persists the caller's value (role ?? 'READER').
    expect(row?.role).toBe('READER');
    expect(app.role).toBe('READER');
  });

  it('createApp WITHOUT a role input also reads READER (both legs pinned)', async () => {
    const app = await resolvers.Mutation.createApp(
      {},
      { agentRef: agentId, name: 'No Input Leg' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(app.role).toBe('READER');
  });

  it('updateApp WITH a role input succeeds and writes nothing: the stored column is untouched', async () => {
    const app = await resolvers.Mutation.createApp(
      {},
      { agentRef: agentId, name: 'Update Pin' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const updated = await resolvers.Mutation.updateApp(
      {},
      { ref: app.id, role: 'OWNER' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(updated).toBeTruthy();
    const row = await db.app.findUnique({ where: { id: app.id }, select: { role: true } });
    // Red on main: the update writes the caller's value.
    expect(row?.role).toBe('READER');
  });
});

describe('#4464 stage 1 — App.role returns the constant READER whatever is stored', () => {
  it('a row stored as OWNER (legacy value, planted directly) still reads READER', async () => {
    const app = await resolvers.Mutation.createApp(
      {},
      { agentRef: agentId, name: 'Legacy Row' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    await db.app.update({ where: { id: app.id }, data: { role: 'OWNER' } });
    const row = await db.app.findUnique({ where: { id: app.id } });
    // The column KEEPS legacy values until the last stage…
    expect(row?.role).toBe('OWNER');
    // …and the field reads the constant. Red on main: no App.role type
    // resolver exists, so the default resolver returns the stored OWNER (and
    // roleOf would be undefined before stage 1 adds the resolver at all).
    expect(roleOf(row)).toBe('READER');
  });

  it('a fresh row (stored READER) also reads READER through the resolver', async () => {
    const app = await resolvers.Mutation.createApp(
      {},
      { agentRef: agentId, name: 'Fresh Row' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(roleOf(app)).toBe('READER');
  });
});

describe('#4464 stage 1 — SDL changes only by @deprecated on the three named places', () => {
  const schema = buildSchema(typeDefs);

  it('App.role is deprecated with the shared notice; the arg of both mutations too', () => {
    const appRole = (schema.getType('App') as { getFields: () => Record<string, { deprecationReason?: string | null }> })
      .getFields().role;
    // The truthiness leg is what discriminates: at main both sides are
    // undefined and a bare toBe(APP_ROLE_DEPRECATION_NOTICE) passes vacuously.
    expect(appRole.deprecationReason).toBeTruthy();
    expect(appRole.deprecationReason).toBe(APP_ROLE_DEPRECATION_NOTICE);

    for (const mutation of ['createApp', 'updateApp'] as const) {
      const field = (schema.getType('Mutation') as unknown as {
        getFields: () => Record<string, { args: { name: string; deprecationReason?: string | null }[] }>;
      }).getFields()[mutation];
      const roleArg = field.args.find((a) => a.name === 'role');
      expect(roleArg, `${mutation}.role must stay in the SDL (stage 1 accepts it)`).toBeTruthy();
      // Red on main: neither arg nor field carries the annotation yet.
      expect(roleArg?.deprecationReason).toBeTruthy();
      expect(roleArg?.deprecationReason).toBe(APP_ROLE_DEPRECATION_NOTICE);
    }
  });

  it('the notice names the removal vehicle, so a reader knows where the clock lives', () => {
    expect(APP_ROLE_DEPRECATION_NOTICE).toContain('4464');
  });
});
