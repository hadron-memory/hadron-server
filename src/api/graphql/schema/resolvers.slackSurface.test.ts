/**
 * Spec 043 Phase 2 — the SlackConnection GraphQL surface.
 *
 * What this file pins:
 *   - createSlackConnection: org-ADMIN gate, App-must-belong-to-org, tool
 *     identity validation (BOTH bot ids land on the row), duplicate
 *     workspace rejection WITH tool-side rollback, token write-only-ness.
 *   - deleteSlackConnection: soft-delete + best-effort tool teardown.
 *   - slackConnection(ref): null for missing AND for non-member (no
 *     existence disclosure).
 *   - slackConnections: uniform page scoped to member orgs; orgId
 *     narrows per cor:api:100:01 (non-member -> empty page).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import {
  createSlackToolConnection,
  deleteSlackToolConnection,
  type SlackToolConnectionIdentity,
} from '../../../lib/slackClient.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/slackClient.js', () => ({
  createSlackToolConnection: vi.fn(),
  deleteSlackToolConnection: vi.fn().mockResolvedValue(undefined),
  runSlackOperation: vi.fn().mockResolvedValue({ ok: true }),
}));

let org: { id: string };
let app: { id: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };

function identity(overrides: Partial<SlackToolConnectionIdentity> = {}): SlackToolConnectionIdentity {
  return {
    id: 'tool-conn-1',
    provider: 'slack',
    teamId: 'T0001',
    teamName: 'Acme',
    botUserId: 'U0BOT',
    botId: 'B0BOT',
    status: 'ACTIVE',
    ...overrides,
  };
}

function ctxFor(userId: string): Context {
  return { db, roles: ['READER'], userId } as Context;
}

async function createUser(name: string, orgId: string | null, role: 'OWNER' | 'ADMIN' | 'READER' = 'READER') {
  const user = await db.user.create({
    data: { id: generateId(), email: `${name}@slk.test`, name },
  });
  if (orgId) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role },
    });
  }
  return user;
}

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(createSlackToolConnection).mockReset();
  vi.mocked(createSlackToolConnection).mockResolvedValue(identity());
  vi.mocked(deleteSlackToolConnection).mockClear();

  org = await db.organization.create({ data: { id: generateId(), name: 'slk-org', urn: 'slk-org' } });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'slk-app', urn: 'slk-org::slk-app' },
  });
  admin = await createUser('admin', org.id, 'ADMIN');
  member = await createUser('member', org.id, 'READER');
  outsider = await createUser('outsider', null);
});

async function createConnection(ctx?: Context) {
  return resolvers.Mutation.createSlackConnection(
    {},
    { orgRef: org.id, appRef: app.id, botToken: 'xoxb-secret', appToken: 'xapp-secret' },
    ctx ?? ctxFor(admin.id),
  );
}

describe('createSlackConnection', () => {
  it('registers via the tool and stores identity with BOTH bot ids — never a token', async () => {
    const connection = await createConnection();
    expect(connection).toMatchObject({
      organizationId: org.id,
      defaultAppId: app.id,
      toolConnectionId: 'tool-conn-1',
      teamId: 'T0001',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      botId: 'B0BOT',
      status: 'ACTIVE',
    });
    expect(createSlackToolConnection).toHaveBeenCalledWith('slack', { botToken: 'xoxb-secret', appToken: 'xapp-secret' });
    // The row carries no token in any column.
    const raw = await db.slackConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(JSON.stringify(raw)).not.toContain('xoxb-secret');
    expect(JSON.stringify(raw)).not.toContain('xapp-secret');
  });

  it('requires org ADMIN (a plain member is Forbidden and the tool is never called)', async () => {
    await expect(createConnection(ctxFor(member.id))).rejects.toThrow('Forbidden');
    expect(createSlackToolConnection).not.toHaveBeenCalled();
  });

  it('rejects an App from another org', async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other-org' } });
    const foreignApp = await db.app.create({
      data: { id: generateId(), organizationId: otherOrg.id, name: 'f-app', urn: 'other-org::f-app' },
    });
    await expect(
      resolvers.Mutation.createSlackConnection(
        {},
        { orgRef: org.id, appRef: foreignApp.id, botToken: 'x', appToken: 'y' },
        ctxFor(admin.id),
      ),
    ).rejects.toThrow(/must belong/);
  });

  it('rejects a duplicate workspace and rolls back the tool-side connection', async () => {
    await createConnection();
    vi.mocked(createSlackToolConnection).mockResolvedValue(identity({ id: 'tool-conn-2' }));
    await expect(createConnection()).rejects.toThrow(/already connected/);
    // The just-created tool row was torn down, not orphaned.
    expect(deleteSlackToolConnection).toHaveBeenCalledWith('slack', 'tool-conn-2');
    expect(await db.slackConnection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('a soft-deleted connection does not block re-registration', async () => {
    const first = await createConnection();
    await resolvers.Mutation.deleteSlackConnection({}, { ref: first.id }, ctxFor(admin.id));
    vi.mocked(createSlackToolConnection).mockResolvedValue(identity({ id: 'tool-conn-3' }));
    const second = await createConnection();
    expect(second.toolConnectionId).toBe('tool-conn-3');
  });
});

describe('deleteSlackConnection', () => {
  it('soft-deletes and tears down the tool side (org ADMIN only)', async () => {
    const connection = await createConnection();
    await expect(
      resolvers.Mutation.deleteSlackConnection({}, { ref: connection.id }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');

    const ok = await resolvers.Mutation.deleteSlackConnection({}, { ref: connection.id }, ctxFor(admin.id));
    expect(ok).toBe(true);
    const row = await db.slackConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(admin.id);
    expect(deleteSlackToolConnection).toHaveBeenCalledWith('slack', 'tool-conn-1');
  });
});

describe('slackConnection(ref)', () => {
  it('returns the row to an org member, and null (not Forbidden) to an outsider', async () => {
    const connection = await createConnection();
    const asMember = await resolvers.Query.slackConnection({}, { ref: connection.id }, ctxFor(member.id));
    expect(asMember?.id).toBe(connection.id);

    // Missing row and non-member row are indistinguishable — both null.
    expect(await resolvers.Query.slackConnection({}, { ref: connection.id }, ctxFor(outsider.id))).toBeNull();
    expect(await resolvers.Query.slackConnection({}, { ref: 'nope' }, ctxFor(member.id))).toBeNull();
  });
});

describe('slackConnections', () => {
  it('pages the caller-accessible set; orgId narrows; non-member gets an empty page', async () => {
    const connection = await createConnection();

    const page = await resolvers.Query.slackConnections({}, {}, ctxFor(member.id));
    expect(page.total).toBe(1);
    expect(page.items[0]!.id).toBe(connection.id);

    const scoped = await resolvers.Query.slackConnections({}, { orgId: org.id }, ctxFor(member.id));
    expect(scoped.total).toBe(1);

    const outsiderPage = await resolvers.Query.slackConnections({}, { orgId: org.id }, ctxFor(outsider.id));
    expect(outsiderPage).toEqual({ items: [], total: 0 });

    const countOnly = await resolvers.Query.slackConnections({}, { limit: 0 }, ctxFor(member.id));
    expect(countOnly).toEqual({ items: [], total: 1 });
  });
});
