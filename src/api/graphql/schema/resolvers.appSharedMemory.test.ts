/**
 * #951 — an App's class='app' shared memory exists from App-install time, and
 * #952 — an existing Agent can be attached to an existing App by the team's
 * own members.
 *
 * Before #951 the shared memory was created lazily on the first shared/team
 * chat post, so a freshly installed App's only memory was the Agent's system
 * memory — read-only from every App that runs it (cor:dmo:050:03). The App had
 * no writable memory at all, which is what badged a correctly-built team App
 * "read-only" in the portal and made `hadron team init -m <memory>` unrunnable
 * (the memory it needs did not exist yet).
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

function ctx(userId?: string, roles: string[] = ['READER']): Context {
  return { db, userId, roles } as Context;
}

let org: { id: string; urn: string };
let admin: { id: string };
let contributor: { id: string };
let appMember: { id: string };
let appReader: { id: string };
let outsider: { id: string };
let owner: { id: string; handle: string };
let agent: { id: string; urn: string };
let otherAgent: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'shared-mem-org', urn: `shared-mem-${s}.com` },
  });
  const mkUser = async (n: number, handle?: string) =>
    db.user.create({
      data: {
        id: generateId(),
        githubId: 95000 + n,
        githubUsername: `sm${n}-${s}`,
        ...(handle ? { handle } : {}),
        roles: ['READER'],
      },
    });
  admin = await mkUser(1);
  contributor = await mkUser(2);
  appMember = await mkUser(3);
  appReader = await mkUser(4);
  outsider = await mkUser(5);
  owner = (await mkUser(6, `sm-owner-${s}`)) as { id: string; handle: string };
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    ],
  });
  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:team-agent`,
      name: 'Team Agent',
      visibility: 'ORGANIZATION',
    },
  });
  otherAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:iris`,
      name: 'Iris',
      visibility: 'ORGANIZATION',
    },
  });
});

/** The App's app-class memories (the shared-memory scheme is per (app, agent)). */
function appMemories(appId: string) {
  return db.memory.findMany({ where: { appId, class: 'app', deletedAt: null } });
}

describe('#951 — createApp provisions the app-class shared memory', () => {
  it('an org-owned App has a writable app-class memory immediately', async () => {
    const app = await M.createApp(
      null,
      { orgRef: org.id, agentRef: agent.id, name: 'Eng Team' },
      ctx(admin.id),
    );
    const memories = await appMemories(app.id);
    expect(memories).toHaveLength(1);
    // #723: identity is the (app, agent) column pair; the urn is a flat
    // single-atom v2 memory slug under the owning org.
    expect(memories[0].sharedMemoryOfAgentId).toBe(agent.id);
    expect(memories[0].urn).toBe(`${org.urn}:${app.urn.split(':').pop()}-shared`);
    // Owned by the App's org (chk_memory_owner_xor), and NOT the read-only
    // system class the Agent's own memory carries.
    expect(memories[0].organizationId).toBe(org.id);
    expect(memories[0].ownerUserId).toBeNull();
    expect(memories[0].class).toBe('app');
  });

  it('a user-owned App gets one too, owned by the user (owner XOR)', async () => {
    const personalAgent = await M.createAgent(null, { name: 'My Agent' }, ctx(owner.id));
    const app = await M.createApp(
      null,
      { agentRef: personalAgent.id, name: 'My App' },
      ctx(owner.id),
    );
    const memories = await appMemories(app.id);
    expect(memories).toHaveLength(1);
    expect(memories[0].ownerUserId).toBe(owner.id);
    expect(memories[0].organizationId).toBeNull();
  });

  it("honors the Agent's memoryProvisioning declaration (spec 008 FR-008)", async () => {
    // An Agent that declares appMemory 'none' (or 'user') published a contract
    // saying it expects no shared per-App memory — eagerly creating shared
    // writable storage for it would contradict that (Codex P1).
    for (const mode of ['none', 'user'] as const) {
      const declining = await db.agent.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}:declines-${mode}`,
          name: `Declines ${mode}`,
          visibility: 'ORGANIZATION',
          memoryProvisioning: { appMemory: mode },
        },
      });
      const app = await M.createApp(
        null,
        { orgRef: org.id, agentRef: declining.id, name: `App ${mode}` },
        ctx(admin.id),
      );
      expect(await appMemories(app.id)).toHaveLength(0);
    }
  });

  it('is idempotent with the lazy chat-time provisioner — no second memory', async () => {
    const app = await M.createApp(
      null,
      { orgRef: org.id, agentRef: agent.id, name: 'Eng Team 2' },
      ctx(admin.id),
    );
    const { findOrCreateAppClassMemory } = await import('./chat-scope.js');
    const again = await findOrCreateAppClassMemory({
      appId: app.id,
      appUrn: app.urn,
      appName: app.name,
      agentId: agent.id,
      agentUrn: agent.urn,
      agentName: 'Team Agent',
      organizationId: org.id,
      ownerUserId: null,
      actingUserId: admin.id,
      db,
    });
    const memories = await appMemories(app.id);
    expect(memories).toHaveLength(1);
    expect(again).toBe(memories[0].id);
  });
});

describe('#952 — installAgentIntoApp attaches an existing Agent to an existing App', () => {
  let app: { id: string; urn: string };

  beforeEach(async () => {
    app = await M.createApp(
      null,
      { orgRef: org.id, agentRef: agent.id, name: 'Roster App' },
      ctx(admin.id),
    );
    await db.appMember.createMany({
      data: [
        { appId: app.id, userId: appMember.id, role: 'engineer' },
        { appId: app.id, userId: appReader.id, role: 'reader' },
      ],
    });
  });

  it('an org CONTRIBUTOR installs a second Agent', async () => {
    await M.installAgentIntoApp(
      null,
      { appRef: app.id, agentRef: otherAgent.id },
      ctx(contributor.id),
    );
    const roster = await db.appAgent.findMany({ where: { appId: app.id } });
    expect(roster.map((r) => r.agentId).sort()).toEqual([agent.id, otherAgent.id].sort());
  });

  it('a plain AppMember cannot — installing is a read grant on the Agent\'s design', async () => {
    // #952 proposed admitting non-'reader' AppMembers here. Not done: an
    // installed Agent's system memory becomes READ_ONLY in every App-context
    // access map and the payload carries its (ungated) definition, so this
    // would hand a non-org member exactly the org Agent definition that
    // Query.agent refuses them.
    await expect(
      M.installAgentIntoApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(appMember.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      M.installAgentIntoApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(appReader.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('a non-member cannot', async () => {
    await expect(
      M.installAgentIntoApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(outsider.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('re-attach after uninstall restores the pairing (cor:dmo:050:03 orphan retention)', async () => {
    await M.installAgentIntoApp(
      null,
      { appRef: app.id, agentRef: otherAgent.id },
      ctx(admin.id),
    );
    // Memories accumulated under the (App, Agent) pairing.
    const orphan = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${app.urn}:iris:shared`,
        name: 'Iris shared',
        class: 'app',
        appId: app.id,
      },
    });
    await M.uninstallAgentFromApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(admin.id));
    expect(await db.memory.findUnique({ where: { id: orphan.id } })).not.toBeNull();

    await M.installAgentIntoApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(admin.id));
    const row = await db.appAgent.findUnique({
      where: { appId_agentId: { appId: app.id, agentId: otherAgent.id } },
    });
    expect(row).not.toBeNull();
  });

  it('uninstall keeps the same org/owner gate — an AppMember cannot detach', async () => {
    await M.installAgentIntoApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(admin.id));
    await expect(
      M.uninstallAgentFromApp(null, { appRef: app.id, agentRef: otherAgent.id }, ctx(appMember.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('a user-owned App still admits only its owner (spec 047)', async () => {
    const personalAgent = await M.createAgent(null, { name: 'Mine' }, ctx(owner.id));
    const personalApp = await M.createApp(
      null,
      { agentRef: personalAgent.id, name: 'Personal App' },
      ctx(owner.id),
    );
    await db.appMember.create({
      data: { appId: personalApp.id, userId: appMember.id, role: 'engineer' },
    });
    const publicAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:public-one`,
        name: 'Public One',
        visibility: 'PUBLIC',
      },
    });
    await expect(
      M.installAgentIntoApp(
        null,
        { appRef: personalApp.id, agentRef: publicAgent.id },
        ctx(appMember.id),
      ),
    ).rejects.toThrow('Forbidden');
  });
});
