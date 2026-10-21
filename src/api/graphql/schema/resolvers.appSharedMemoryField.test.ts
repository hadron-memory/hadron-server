import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #965 — `App.sharedMemory`: the App → shared-memory hop.
 *
 * Before this field the reverse mapping existed (`Memory.appId`) but nothing
 * answered "what is this App's shared app-class memory?", so a CLI client
 * defaulting a team-memory argument (hadron-cli#399) had to list every
 * readable memory and filter — a whole-corpus scan that is wrong under
 * pagination. The field is read-only (never provisions) and resolves:
 *   1. the memory holding the App's `worklog` root (oldest — mirrors
 *      locateWorklogRoot, so the answer matches where recordTeamWork writes),
 *   2. else the oldest agent-keyed shared row (`sharedMemoryOfAgentId` set —
 *      the #951 install-provisioned pairing). Worker working memories are
 *      also app-class rows under the App and must never be this answer.
 * Gated by the RECORD-level memory read gate; null when unreadable or absent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const A = (resolvers as any).App;

function ctx(userId?: string, roles: string[] = ['READER']): Context {
  return { db, userId, roles } as Context;
}

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let agent: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'shared-mem-field-org', urn: `smf-${s}.com` },
  });
  const mkUser = async (n: number) =>
    db.user.create({
      data: {
        id: generateId(),
        githubId: 96000 + n,
        githubUsername: `smf${n}-${s}`,
        roles: ['READER'],
      },
    });
  admin = await mkUser(1);
  member = await mkUser(2);
  outsider = await mkUser(3);
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' },
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
});

async function createApp(name: string) {
  const app = await M.createApp(null, { orgRef: org.id, agentRef: agent.id, name }, ctx(admin.id));
  // The team memory's audience is App participation, not any org READER.
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  return app;
}

describe('#965 — App.sharedMemory', () => {
  it('resolves the #951-provisioned agent-keyed shared memory for an App participant', async () => {
    const app = await createApp('Eng Team');
    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem).not.toBeNull();
    expect(mem.appId).toBe(app.id);
    expect(mem.class).toBe('app');
    expect(mem.sharedMemoryOfAgentId).toBe(agent.id);
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: member.id } } });
    expect(await A.sharedMemory(app, {}, ctx(member.id))).toBeNull();
  });

  it('never answers with a Worker working memory (app-class but unkeyed)', async () => {
    const app = await createApp('Eng Team W');
    const shared = await db.memory.findFirstOrThrow({
      where: { appId: app.id, class: 'app' },
    });
    // A worker working memory: same class, same appId — and forced OLDER than
    // the shared row so "oldest wins" alone would pick it if the discriminator
    // were missing.
    //
    // #1031 made this fixture FAITHFUL by attaching the Worker. It previously
    // created the memory alone, which no producer does: provisionWorkerMemory
    // creates the memory and sets Worker.memoryId in ONE transaction,
    // precisely so a rollback cannot leave an orphan. The unattached row was a
    // fifth shape that exists in no code path.
    //
    // That mattered because the unattached row was being excluded by
    // `sharedMemoryOfAgentId: { not: null }` — a filter that also excludes
    // LEGACY (pre-#723) team spaces, which is the bug the test was
    // accidentally protecting. `workerOf` is the real discriminator for this
    // shape (findings:app-class-is-four-row-shapes), and it only discriminates
    // if the Worker is actually there.
    const workerMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:eng-team-w-iris`,
        name: 'Eng Team W — Iris — working memory',
        class: 'app',
        visibility: null,
        appId: app.id,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const roleAgent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        appId: app.id,
        agentId: roleAgent.id,
        name: `Iris-${Date.now()}`,
        slug: `iris-${Date.now()}`,
        memoryId: workerMem.id,
      },
    });
    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem?.id).toBe(shared.id);
    expect(mem?.id).not.toBe(workerMem.id);
  });

  it('still finds a LEGACY (pre-#723) team space, whose sharedMemoryOfAgentId is null', async () => {
    // NOT a new feature — behaviour that predates #1031 and that requiring the
    // #723 key would have silently removed (PR #1066 review, Copilot). Legacy
    // rows are column-identical to name-addressable memories, so they are
    // matched by URN through memoryCarriesLegacyKeyFor.
    const app = await createApp('Eng Team Legacy');
    const shared = await db.memory.findFirstOrThrow({
      where: { appId: app.id, class: 'app' },
    });
    const agent = await db.agent.findFirstOrThrow({
      where: { id: shared.sharedMemoryOfAgentId! },
    });
    // Put the row back into its pre-#723 shape: key null, identity in the urn.
    const agentSlug = agent.urn.split(':').slice(1).join(':');
    await db.memory.update({
      where: { id: shared.id },
      data: { sharedMemoryOfAgentId: null, urn: `${app.urn}:${agentSlug}:shared` },
    });

    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem?.id).toBe(shared.id);
  });

  it('keeps a LEGACY space recognisable after its agent is UNINSTALLED', async () => {
    // Uninstall hard-deletes the AppAgent row and deliberately RETAINS the
    // pairing's memories (FR-005), so anything that identifies a legacy space
    // from the current install roster loses that history the moment an agent
    // is removed — while the adopted branch, keyed on a column, keeps working
    // (PR #1066 review, Codex). The row is recognised from its own urn.
    const app = await createApp('Eng Team Uninstalled');
    const shared = await db.memory.findFirstOrThrow({
      where: { appId: app.id, class: 'app' },
    });
    const agent = await db.agent.findFirstOrThrow({
      where: { id: shared.sharedMemoryOfAgentId! },
    });
    const agentSlug = agent.urn.split(':').slice(1).join(':');
    await db.memory.update({
      where: { id: shared.id },
      data: { sharedMemoryOfAgentId: null, urn: `${app.urn}:${agentSlug}:shared` },
    });
    // ...and the agent is uninstalled afterwards.
    await db.appAgent.deleteMany({ where: { appId: app.id, agentId: agent.id } });

    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem?.id).toBe(shared.id);
  });

  it('never answers with a NAME-ADDRESSABLE app memory (createMemoryInApp)', async () => {
    // The shape that column-narrowing alone cannot exclude, found in review of
    // PR #1066: createMemoryInApp(memoryClass: 'app') produces appId set, no
    // Worker, no user key, and its OWN sharedMemoryOfAgentId null — matching
    // every other clause of appTeamSpaceFilter. Forced older so oldest-first
    // would pick it if the shared key were not required.
    const app = await createApp('Eng Team Named');
    const shared = await db.memory.findFirstOrThrow({
      where: { appId: app.id, class: 'app' },
    });
    const named = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:eng-team-named:app-mem:notes`,
        name: 'notes',
        class: 'app',
        visibility: null,
        appId: app.id,
        createdAt: new Date(Date.now() - 60_000),
      },
    });

    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem?.id).toBe(shared.id);
    expect(mem?.id).not.toBe(named.id);
  });

  it('prefers the memory holding the worklog root over an older keyed row', async () => {
    const app = await createApp('Eng Team WL');
    // A second installed agent's shared memory, younger, carrying the worklog
    // root: the ledger home must win even though the founding pairing is older.
    const second = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:second-agent`,
        name: 'Second Agent',
        visibility: 'ORGANIZATION',
      },
    });
    const teamMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:eng-team-wl-shared-second`,
        name: 'Eng Team WL — Second Agent — shared chats',
        class: 'app',
        visibility: null,
        appId: app.id,
        sharedMemoryOfAgentId: second.id,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: teamMem.id,
        loc: 'worklog',
        name: 'worklog',
        nodeType: 'info',
      },
    });
    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem?.id).toBe(teamMem.id);
  });

  it('returns null for an App with no shared memory (pre-#951 shape)', async () => {
    const app = await createApp('Bare App');
    await db.memory.deleteMany({ where: { appId: app.id, class: 'app' } });
    expect(await A.sharedMemory(app, {}, ctx(member.id))).toBeNull();
  });

  it('returns null (not Forbidden) when the caller cannot read the memory record', async () => {
    const app = await createApp('Gated App');
    expect(await A.sharedMemory(app, {}, ctx(outsider.id))).toBeNull();
  });

  it('ignores a soft-deleted shared memory', async () => {
    const app = await createApp('Deleted Mem App');
    await db.memory.updateMany({
      where: { appId: app.id, class: 'app' },
      data: { deletedAt: new Date() },
    });
    expect(await A.sharedMemory(app, {}, ctx(member.id))).toBeNull();
  });

  it('an App-only member (not an org member) reads the shared memory (#982 review, Codex P1)', async () => {
    // The external/B2C shape: an AppMember with no OrgMember row. They
    // participate in the App's shared memory (team chat + worklog admit
    // them), and the CLI defaulting this field exists for serves them too —
    // the record gate must not send them the org-membership way.
    const app = await createApp('External Member App');
    await db.appMember.create({ data: { appId: app.id, userId: outsider.id, role: 'member' } });
    const mem = await A.sharedMemory(app, {}, ctx(outsider.id));
    expect(mem).not.toBeNull();
    expect(mem.appId).toBe(app.id);
  });

  it('a worker memory carrying a hand-created worklog node never wins (#982 review, Copilot)', async () => {
    const app = await createApp('Worklog Trap App');
    const shared = await db.memory.findFirstOrThrow({ where: { appId: app.id, class: 'app' } });
    // A worker working memory, OLDER than the shared row, with a worklog
    // node planted via the generic node surface — without the workerOf
    // exclusion the worklog-first branch would resolve here.
    const workerMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:wlt-iris`,
        name: 'Worklog Trap — Iris — working memory',
        class: 'app',
        visibility: null,
        appId: app.id,
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', memoryId: workerMem.id },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: workerMem.id,
        loc: 'worklog',
        name: 'worklog',
        nodeType: 'info',
        createdAt: new Date(Date.now() - 110_000),
      },
    });
    const mem = await A.sharedMemory(app, {}, ctx(member.id));
    expect(mem?.id).toBe(shared.id);
    expect(mem?.id).not.toBe(workerMem.id);
  });
});
