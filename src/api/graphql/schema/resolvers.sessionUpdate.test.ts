/**
 * #931 — updateSession + the session write gate.
 *
 * `updateSession(id, prNumber, branch)` sets a live session's mutable
 * provenance fields mid-session (a PR is opened after startSession ran).
 * Both it and `endSession` share `requireSessionWriteAccess`: platform
 * admin, the session's App, or the attributed user (identity-scoped, not
 * via impersonation). endSession was previously UNGATED — any principal
 * holding a session id could end it; these tests pin the gate on both.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

function ctx(over: Partial<Context> = {}): Context {
  return { db, roles: ['READER'], ...over };
}

let creator: { id: string };
let stranger: { id: string };
let admin: { id: string };
let app: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  creator = await db.user.create({
    data: { id: generateId(), githubId: 93101, githubUsername: `sess-creator-${suffix}`, roles: ['READER'] },
  });
  stranger = await db.user.create({
    data: { id: generateId(), githubId: 93102, githubUsername: `sess-stranger-${suffix}`, roles: ['READER'] },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 93103, githubUsername: `sess-admin-${suffix}`, roles: ['ADMIN'] },
  });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'sess-org', urn: `sess-org-${suffix}.com` },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'sess-app', urn: `sess-org-${suffix}.com::sess-app` },
  });
});

async function startAs(userId?: string, appId?: string) {
  return M.startSession(
    {},
    { input: { id: generateId(), tool: 'claude-code' } },
    ctx({ userId, appId }),
  );
}

describe('updateSession (#931)', () => {
  it('lets the attributed user set prNumber and branch mid-session, and clear with explicit null', async () => {
    const s = await startAs(creator.id);
    const updated = await M.updateSession(
      {},
      { id: s.id, prNumber: 934, branch: '931-update-session' },
      ctx({ userId: creator.id }),
    );
    expect(updated.prNumber).toBe(934);
    expect(updated.branch).toBe('931-update-session');

    // Omitted preserves; explicit null clears.
    const cleared = await M.updateSession({}, { id: s.id, prNumber: null }, ctx({ userId: creator.id }));
    expect(cleared.prNumber).toBeNull();
    expect(cleared.branch).toBe('931-update-session');
  });

  it('bumps updatedAt on an empty update — the liveness touch (#930)', async () => {
    const s = await startAs(creator.id);
    const before = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    await new Promise((r) => setTimeout(r, 10));
    await M.updateSession({}, { id: s.id }, ctx({ userId: creator.id }));
    const after = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.updatedAt!.getTime()).toBeGreaterThan(before.updatedAt?.getTime() ?? 0);
  });

  it('still works after the session ended (late PR-merge attribution)', async () => {
    const s = await startAs(creator.id);
    await M.endSession({}, { id: s.id }, ctx({ userId: creator.id }));
    const updated = await M.updateSession({}, { id: s.id, prNumber: 934 }, ctx({ userId: creator.id }));
    expect(updated.prNumber).toBe(934);
  });

  it('refuses a stranger, an impersonated self, and rewards the App and the platform admin', async () => {
    const s = await startAs(creator.id);
    await expect(
      M.updateSession({}, { id: s.id, prNumber: 1 }, ctx({ userId: stranger.id })),
    ).rejects.toThrow(/Forbidden/);
    // Identity-scoped: the attributed user via an impersonated session is refused.
    await expect(
      M.updateSession(
        {},
        { id: s.id, prNumber: 1 },
        ctx({ userId: creator.id, impersonation: { orgId: 'any' } as any }),
      ),
    ).rejects.toThrow(/Forbidden/);
    // Platform admin passes.
    const byAdmin = await M.updateSession({}, { id: s.id, prNumber: 2 }, ctx({ userId: admin.id, roles: ['ADMIN'] }));
    expect(byAdmin.prNumber).toBe(2);

    // App-key caller: only for the session's own App.
    const appSession = await startAs(undefined, app.id);
    const byApp = await M.updateSession({}, { id: appSession.id, prNumber: 3 }, ctx({ appId: app.id }));
    expect(byApp.prNumber).toBe(3);
    await expect(
      M.updateSession({}, { id: appSession.id, prNumber: 4 }, ctx({ appId: generateId() })),
    ).rejects.toThrow(/Forbidden/);

    // Hybrid principal (a user with an active-App selection — the MCP auth
    // shape): the App branch must NOT apply (#932 Codex P1). A co-member of
    // the session's App who is not its attributed user stays Forbidden.
    const memberSession = await startAs(creator.id, app.id);
    await expect(
      M.updateSession({}, { id: memberSession.id, prNumber: 5 }, ctx({ userId: stranger.id, appId: app.id })),
    ).rejects.toThrow(/Forbidden/);
    // …while the attributed user, also carrying the App selection, passes.
    const bySelf = await M.updateSession({}, { id: memberSession.id, prNumber: 6 }, ctx({ userId: creator.id, appId: app.id }));
    expect(bySelf.prNumber).toBe(6);
  });

  it('maps an unknown id to BAD_USER_INPUT', async () => {
    try {
      await M.updateSession({}, { id: 'no-such-session', prNumber: 1 }, ctx({ userId: creator.id }));
      expect.fail('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT');
    }
  });
});

describe('endSession gate (#931 — previously ungated)', () => {
  it('lets the attributed user end their session, refuses a stranger', async () => {
    const s = await startAs(creator.id);
    await expect(
      M.endSession({}, { id: s.id, summary: 'hijacked' }, ctx({ userId: stranger.id })),
    ).rejects.toThrow(/Forbidden/);
    const ended = await M.endSession({}, { id: s.id, summary: 'done' }, ctx({ userId: creator.id }));
    expect(ended.endedAt).not.toBeNull();
    expect(ended.summary).toBe('done');
  });

  it("lets the session's App end it, refuses a foreign App key", async () => {
    const s = await startAs(undefined, app.id);
    await expect(
      M.endSession({}, { id: s.id }, ctx({ appId: generateId() })),
    ).rejects.toThrow(/Forbidden/);
    const ended = await M.endSession({}, { id: s.id }, ctx({ appId: app.id }));
    expect(ended.endedAt).not.toBeNull();
  });
});
