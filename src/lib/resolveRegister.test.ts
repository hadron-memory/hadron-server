import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
/**
 * Spec 049 Phase 6 — resolveRegister and its consumers, what is pinned:
 *   - the install default applies to a Worker through its Agent-in-App
 *     (namedBy AGENT); operational views use the ACTOR's standing, while
 *     GraphQL effective views use the attendee's current standing;
 *   - precedence per Channel: App › org, Worker › Agent › everyone — never
 *     unioned; a bare Agent-in-App attendee does not inherit a Worker row;
 *   - a deleted Channel is disclosed (CHANNEL_DELETED), impersonation is
 *     read-only (IMPERSONATION), and nothing is dropped;
 *   - Worker.prompt appends the register block through renderDerivedBlocks,
 *     and appends nothing for an attendee with no rows;
 *   - mintAppRun snapshots the Agent-in-App register (rows only), a run with
 *     no Agent has none, and AppRun.register re-evaluates for the caller;
 *   - attendeeRegister is gated on App participation: a stranger gets [].
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { ensureChannelWithRoot } from './channels.js';
import { parseRunRegisterSnapshot, renderDerivedBlocks, resolveRegister } from './resolveRegister.js';
import { mintAppRun } from '../jobs/appRuns.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const W = (resolvers as any).Worker;
const R = (resolvers as any).AppRun;

let org: { id: string; urn: string };
let admin: { id: string };
let reader: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string };
let agent: { id: string; urn: string };
let appMem: { id: string; urn: string };
let worker: { id: string; slug: string };
let channel: { id: string };
let entry: string;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'rr', urn: `rr-${t}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'rr-b', urn: `rr-b-${t}` } });
  const mk = (n: number, tag: string) => db.user.create({ data: { id: generateId(), githubId: 49400 + n, githubUsername: `rr-${tag}-${t}` } });
  admin = await mk(1, 'admin');
  reader = await mk(2, 'reader');
  stranger = await mk(3, 'stranger');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: stranger.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION', personaRole: 'engineer' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'admin' } });
  appMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', heldByUserId: admin.id } });
  channel = (await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id })).channel;
  const node = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'tasks:go', name: 'go', nodeType: 'task', content: 'go', isRunnable: true } });
  entry = `hrn:node:${appMem.urn}:${node.loc}`;
});

describe('resolveRegister', () => {
  it('the install default applies to the Worker through its Agent; standing is the actor\'s', async () => {
    const asAdmin = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: ctx(admin.id) });
    expect(asAdmin?.attendeeUrn).toBe(`hrn:worker:${org.urn}:team:iris`);
    expect(asAdmin?.rows).toHaveLength(1);
    expect(asAdmin?.rows[0]).toMatchObject({
      entry: { namedBy: 'AGENT', installDefault: true, role: 'BOTH' },
      channel: { id: channel.id, loc: 'chats:team', hostMemoryUrn: `hrn:mem:${appMem.urn}`, lastSeq: 0 },
      canRead: true, canPost: true, disclosure: null,
    });
    const asReader = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: ctx(reader.id) });
    expect(asReader?.rows[0]).toMatchObject({ canRead: false, canPost: false, disclosure: 'HOST_MEMORY_NOT_READABLE', channel: { hostMemoryUrn: null } });
    const noActor = await resolveRegister(db, { attendee: { workerId: worker.id } });
    expect(noActor?.rows[0]).toMatchObject({ canRead: false, canPost: 'UNKNOWN', disclosure: 'UNKNOWN_ACTOR' });
    expect(await resolveRegister(db, { attendee: { workerId: 'nope' }, actor: ctx(admin.id) })).toBeNull();
  });

  it('separates the access subject from the viewer without revealing a hidden host memory', async () => {
    const subjectDenied = await resolveRegister(db, {
      attendee: { workerId: worker.id }, actor: ctx(admin.id), accessActor: ctx(reader.id),
    });
    expect(subjectDenied?.rows[0]).toMatchObject({
      canRead: false, canPost: false, disclosure: 'HOST_MEMORY_NOT_READABLE',
      channel: { hostMemoryId: appMem.id, hostMemoryUrn: `hrn:mem:${appMem.urn}` },
    });

    const viewerDenied = await resolveRegister(db, {
      attendee: { workerId: worker.id }, actor: ctx(reader.id), accessActor: ctx(admin.id),
    });
    expect(viewerDenied?.rows[0]).toMatchObject({
      canRead: true, canPost: true, disclosure: null,
      channel: { hostMemoryId: null, hostMemoryUrn: null },
    });
  });

  it('precedence per Channel: App › org, Worker › Agent › everyone; never unioned', async () => {
    const release = (await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:release', name: 'release', createdBy: admin.id })).channel;
    // org: everyone WATCHES release; App: Iris POSTS, mention-only.
    await M.createRegisterEntry({}, { input: { ownerRef: org.urn, channelRef: release.id, role: 'WATCH' } }, ctx(admin.id));
    await M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: release.id, attendeeRef: worker.id, role: 'POST', mentionOnly: true } }, ctx(admin.id));
    const iris = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: ctx(admin.id) });
    const irisRelease = iris!.rows.find((r) => r.channel.id === release.id)!;
    expect(irisRelease.entry).toMatchObject({ namedBy: 'WORKER', ownerType: 'APP', role: 'POST', mentionOnly: true });
    // The bare Agent-in-App attendee does not inherit Iris's row: the org's everyone row stands.
    const agentView = await resolveRegister(db, { attendee: { agentId: agent.id, appId: app.id }, actor: ctx(admin.id) });
    expect(agentView!.rows.find((r) => r.channel.id === release.id)!.entry).toMatchObject({ namedBy: 'EVERYONE', ownerType: 'ORGANIZATION', role: 'WATCH', mentionOnly: false });
    expect(agentView!.rows).toHaveLength(2);
  });

  it('a deleted Channel is disclosed, impersonation is read-only, nothing is dropped', async () => {
    const release = (await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:release', name: 'release', createdBy: admin.id })).channel;
    await M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: release.id } }, ctx(admin.id));
    await M.deleteChannel({}, { ref: release.id }, ctx(admin.id));
    const view = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: ctx(admin.id) });
    expect(view!.rows).toHaveLength(2);
    expect(view!.rows.find((r) => r.channel.id === release.id)).toMatchObject({ channel: { deleted: true }, canPost: false, disclosure: 'CHANNEL_DELETED' });
    const support = { ...ctx(admin.id), impersonation: { orgId: org.id, adminUserId: stranger.id } } as unknown as Context;
    const seen = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: support });
    // A support session never posts; whether it may READ the App-class host follows the
    // impersonation read gate (org-scoped, App-internal memories excluded), so the reason is
    // IMPERSONATION when readable and HOST_MEMORY_NOT_READABLE otherwise — never a grant.
    const row = seen!.rows.find((r) => r.channel.id === channel.id)!;
    expect(row.canPost).toBe(false);
    expect(['IMPERSONATION', 'HOST_MEMORY_NOT_READABLE']).toContain(row.disclosure);
  });

  it('Worker.prompt appends the register block through renderDerivedBlocks; none for an attendee without rows', async () => {
    const before = process.env.BOOT_PROMPT_SERVE_ENABLED;
    process.env.BOOT_PROMPT_SERVE_ENABLED = 'true';
    try {
      await serveAgentBootPrompt(db, agent.id, 'You are {{worker.name}}, the {{worker.role}}.');
      const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
      const prompt = await W.prompt(w, {}, ctx(admin.id));
      expect(prompt).toContain('You are Iris, the engineer.');
      expect(prompt).toContain('## Channels (register)');
      expect(prompt).toContain(`- team — hrn:mem:${appMem.urn}:chats:team: both, install default; read + post; no messages yet`);
      expect(renderDerivedBlocks(null)).toBe('');
      await db.registerEntry.updateMany({ where: { appId: app.id }, data: { deletedAt: new Date() } });
      expect(await W.prompt(w, {}, ctx(admin.id))).toBe('You are Iris, the engineer.');
    } finally {
      if (before === undefined) delete process.env.BOOT_PROMPT_SERVE_ENABLED; else process.env.BOOT_PROMPT_SERVE_ENABLED = before;
    }
  });

  it('reports the Worker holder\'s access to an admin viewer, and no access when unheld', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: reader.id } });
    const held = await Q.attendeeRegister({}, { workerRef: worker.id }, ctx(admin.id));
    expect(held[0]).toMatchObject({
      canRead: false, canPost: false, disclosure: 'UNKNOWN_ACTOR',
      channel: { hostMemoryId: appMem.id },
    });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await W.prompt(w, {}, ctx(admin.id))).toContain('no eligible driver (read + post unavailable)');
    expect(await Q.attendeeRegister({}, { workerRef: worker.id }, ctx(stranger.id))).toEqual([]);

    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: null, heldAt: null } });
    const unheld = await Q.attendeeRegister({}, { workerRef: worker.id }, ctx(admin.id));
    expect(unheld[0]).toMatchObject({ canRead: false, canPost: false, disclosure: 'UNKNOWN_ACTOR' });
    expect(await W.prompt(w, {}, ctx(admin.id))).toContain('no eligible driver (read + post unavailable)');
  });

  it('does not mistake a revoked holder\'s independent Channel read for Worker access', async () => {
    const independent = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:independent`, name: 'independent', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    const independentChannel = (await ensureChannelWithRoot(db, {
      memoryId: independent.id, loc: 'chats:independent', name: 'independent', createdBy: admin.id,
    })).channel;
    await M.createRegisterEntry({}, {
      input: { ownerRef: org.urn, channelRef: independentChannel.id, attendeeRef: worker.id, role: 'WATCH' },
    }, ctx(admin.id));
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: admin.id } } });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { role: 'READER' } });

    // The former driver still reads this org Channel as themselves.
    const personal = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: ctx(admin.id) });
    expect(personal?.rows.find((row) => row.channel.id === independentChannel.id)?.canRead).toBe(true);
    // The App key may inspect its Worker's register, but the revoked holder
    // cannot act as that Worker and must not inherit their personal read.
    const effective = await Q.attendeeRegister({}, { workerRef: worker.id }, { db, appId: app.id } as Context);
    expect(effective.find((row: { channel: { id: string } }) => row.channel.id === independentChannel.id))
      .toMatchObject({ canRead: false, canPost: false, disclosure: 'UNKNOWN_ACTOR' });
  });

  it('mintAppRun snapshots the Agent-in-App register; AppRun.register evaluates its App principal', async () => {
    const run = await mintAppRun(db, {
      organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false,
    });
    const snap = parseRunRegisterSnapshot(run.registerSnapshot);
    expect(snap).toMatchObject({ attendee: { agentId: agent.id, appId: app.id } });
    expect(snap!.rows).toHaveLength(1);
    expect(snap!.rows[0]).toMatchObject({ channelId: channel.id, attendeeAgentId: agent.id, installDefault: true });
    // The audit columns travel with the snapshot: entry.createdAt is the row's, never an epoch.
    const installRow = await db.registerEntry.findFirstOrThrow({ where: { appId: app.id } });
    expect(snap!.rows[0].createdAt).toBe(installRow.createdAt.toISOString());
    const rows = await R.register(run, {}, ctx(admin.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ namedBy: 'AGENT', canRead: true, canPost: false, disclosure: 'HOST_MEMORY_NOT_WRITABLE', channel: { id: channel.id } });
    expect((rows[0].entry as { createdAt: Date }).createdAt.getTime()).toBeGreaterThan(0);
    expect(await R.register(run, {}, ctx(reader.id))).toEqual([expect.objectContaining({
      canRead: true, canPost: false, disclosure: 'HOST_MEMORY_NOT_WRITABLE',
      channel: expect.objectContaining({ hostMemoryId: null, hostMemoryUrn: null }),
    })]);
    const bare = await mintAppRun(db, { organizationId: org.id, appId: app.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false });
    expect(bare.registerSnapshot).toBeNull();
    expect(await R.register(bare, {}, ctx(admin.id))).toEqual([]);
  });

  it('attendeeRegister is gated on App participation', async () => {
    const mine = await Q.attendeeRegister({}, { workerRef: worker.id }, ctx(admin.id));
    expect(mine).toHaveLength(1);
    expect(mine[0].entry.id).toBeDefined();
    expect(await Q.attendeeRegister({}, { agentRef: agent.urn, appRef: app.urn }, ctx(admin.id))).toEqual([
      expect.objectContaining({ canRead: true, canPost: false, disclosure: 'HOST_MEMORY_NOT_WRITABLE' }),
    ]);
    expect(await Q.attendeeRegister({}, { workerRef: worker.id }, ctx(stranger.id))).toEqual([]);
    expect(await Q.attendeeRegister({}, { workerRef: 'nope' }, ctx(admin.id))).toEqual([]);
    await expect(Q.attendeeRegister({}, {}, ctx(admin.id))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('channelReadState returns the attendee cursor without evaluating the viewer\'s access', async () => {
    const state = await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: channel.id }, ctx(admin.id));
    expect(state).toMatchObject({ attendeeUrn: `hrn:worker:${org.urn}:team:iris`, channelId: channel.id, lastSeenSeq: 0 });
    expect(await Q.channelReadState({}, { attendeeRef: worker.id, channelRef: channel.id }, ctx(stranger.id))).toBeNull();
  });
});

describe('PR #1167 review — the oracles', () => {
  it('an unreadable host memory discloses neither URN nor id; an uninstalled Agent is not an attendee', async () => {
    const asReader = await resolveRegister(db, { attendee: { workerId: worker.id }, actor: ctx(reader.id) });
    expect(asReader?.rows[0].channel).toMatchObject({ hostMemoryUrn: null, hostMemoryId: null });
    const rows = await R.register(
      await mintAppRun(db, { organizationId: org.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false }),
      {},
      ctx(reader.id),
    );
    expect(rows[0].channel.hostMemoryId).toBeNull();
    // A live Agent that is NOT installed in the App — even one of another
    // tenant — never resolves as an Agent-in-App attendee.
    const foreign = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'loose', urn: `${org.urn}:loose`, visibility: 'ORGANIZATION' } });
    expect(await resolveRegister(db, { attendee: { agentId: foreign.id, appId: app.id }, actor: ctx(admin.id) })).toBeNull();
    expect(await Q.attendeeRegister({}, { agentRef: foreign.urn, appRef: app.urn }, ctx(admin.id))).toEqual([]);
  });
});
