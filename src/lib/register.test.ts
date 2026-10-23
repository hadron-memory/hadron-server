import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
/**
 * Spec 049 Phase 5 — the chat register (D-2026-09-13-007), what is pinned:
 *   - the install default is MATERIALISED: the moment an App gets its default
 *     Channel every live install has a row; a later install gets one; a second
 *     run writes nothing; uninstall soft-deletes the App's rows for that Agent;
 *     the Agent's declared `registerDefaults.mentionOnly` is honoured;
 *   - owner gates: org CONTRIBUTOR creates an org row, a READER cannot; an org
 *     ADMIN creates an App row; an App-side admin who is not an org
 *     CONTRIBUTOR cannot remove the org's row; the owner removes its own;
 *   - attendee resolution: a Worker in the App, an Agent installed in the App;
 *     a Worker of another App is "no match"; nobody = every attendee;
 *   - the natural key: one live row per (owner, Channel, attendee), freed by
 *     delete;
 *   - reads follow the host memory OR the owner side: a stranger sees null and
 *     an empty page; an owner-side reader who cannot read the host memory
 *     sees the row with `channel: null`;
 *   - the backfill's step 3 writes the rows for Apps whose default it made.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { installAgentIntoAppCore, uninstallAgentFromAppCore } from '../api/graphql/schema/resolvers.helpers.js';
import { ensureChannelWithRoot } from './channels.js';
import { INSTALL_DEFAULT_DESCRIPTION, ensureInstallRegisterRows } from './registerInstall.js';
import { backfillChannels } from '../jobs/backfillChannels.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const RE = (resolvers as any).RegisterEntry;

let org: { id: string; urn: string };
let orgB: { id: string; urn: string };
let admin: { id: string };
let contributor: { id: string };
let reader: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string; name: string };
let agent: { id: string; urn: string };
let agent2: { id: string; urn: string };
let appMem: { id: string; urn: string };
let worker: { id: string; slug: string };

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'rg', urn: `rg-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'rg-b', urn: `rg-b-${t}` } });
  const mk = (n: number, tag: string) => db.user.create({ data: { id: generateId(), githubId: 49200 + n, githubUsername: `rg-${tag}-${t}` } });
  admin = await mk(1, 'admin');
  contributor = await mk(2, 'contrib');
  reader = await mk(3, 'reader');
  stranger = await mk(4, 'stranger');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: stranger.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  agent2 = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'agent2', urn: `${org.urn}:agent2`, visibility: 'ORGANIZATION', registerDefaults: { mentionOnly: true } },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'admin' } });
  appMem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
});

async function defaultChannel() {
  const { channel } = await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
  return channel;
}

describe('the install default (D2)', () => {
  it('is materialised when the App gets its default Channel, added on install, honours registerDefaults, idempotent, removed on uninstall', async () => {
    const channel = await defaultChannel();
    const rows = await db.registerEntry.findMany({ where: { appId: app.id, deletedAt: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: channel.id, attendeeAgentId: agent.id, role: 'BOTH', mentionOnly: false, installDefault: true, description: INSTALL_DEFAULT_DESCRIPTION });
    // A second call writes nothing (the partial unique).
    expect(await ensureInstallRegisterRows(db, app.id)).toBe(0);
    // Installing a second Agent — one whose declared default is mention-only.
    await installAgentIntoAppCore(ctx(admin.id), { appRef: app.urn, agentRef: agent2.urn });
    const second = await db.registerEntry.findFirst({ where: { appId: app.id, attendeeAgentId: agent2.id, deletedAt: null } });
    expect(second?.mentionOnly).toBe(true);
    expect(second?.installDefault).toBe(true);
    // Uninstall soft-deletes the App's rows for that attendee.
    await uninstallAgentFromAppCore(ctx(admin.id), { appRef: app.urn, agentRef: agent2.urn });
    expect(await db.registerEntry.count({ where: { appId: app.id, attendeeAgentId: agent2.id, deletedAt: null } })).toBe(0);
    expect(await db.registerEntry.count({ where: { appId: app.id, attendeeAgentId: agent2.id } })).toBe(1);
  });

  it('the backfill writes the rows for an App whose default it provisions', async () => {
    const run = await backfillChannels(db, { apply: true });
    expect(run.defaultsProvisioned).toBe(1);
    // The creation core wrote the row with the default itself (step 2); step 3 found nothing missing.
    expect(run.registerRowsCreated).toBe(0);
    const a = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(await db.registerEntry.count({ where: { appId: app.id, channelId: a.defaultChannelId!, attendeeAgentId: agent.id, installDefault: true } })).toBe(1);
    expect((await backfillChannels(db, { apply: true })).registerRowsCreated).toBe(0);
  });
});

describe('owner gates and attendees', () => {
  it('org CONTRIBUTOR creates an org row; READER cannot; org ADMIN creates an App row; each owner removes its own', async () => {
    const channel = await defaultChannel();
    const orgRow = await M.createRegisterEntry({}, { input: { ownerRef: org.urn, channelRef: channel.id, attendeeRef: `hrn:worker:${org.urn}:team:iris`, role: 'WATCH' } }, ctx(contributor.id));
    expect(orgRow).toMatchObject({ organizationId: org.id, appId: null, attendeeWorkerId: worker.id, attendeeAgentId: null, role: 'WATCH' });
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: org.urn, channelRef: channel.id } }, ctx(reader.id)),
    ).rejects.toThrow(/Forbidden/);
    // The install default already holds (App, channel, agent) — the SAME key.
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id, attendeeRef: agent.urn } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'REGISTER_ENTRY_EXISTS' } });
    const appRow = await M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id, attendeeRef: worker.id, description: 'Iris watches' } }, ctx(admin.id));
    expect(appRow).toMatchObject({ appId: app.id, organizationId: null, attendeeWorkerId: worker.id, installDefault: false });
    // A CONTRIBUTOR is not an App admin: the App row is not theirs to write.
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id } }, ctx(contributor.id)),
    ).rejects.toThrow(/Forbidden/);
    expect(await M.deleteRegisterEntry({}, { ref: appRow.id }, ctx(admin.id))).toBe(true);
    expect(await M.deleteRegisterEntry({}, { ref: orgRow.id }, ctx(contributor.id))).toBe(true);
  });

  it('the natural key: one live row per (owner, Channel, attendee); the install default is that key; a deleted row frees it', async () => {
    const channel = await defaultChannel();
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id, attendeeRef: agent.urn } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'REGISTER_ENTRY_EXISTS' } });
    const everyone = await M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id } }, ctx(admin.id));
    expect(everyone.attendeeWorkerId).toBeNull();
    expect(everyone.attendeeAgentId).toBeNull();
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'REGISTER_ENTRY_EXISTS' } });
    expect(await M.deleteRegisterEntry({}, { ref: everyone.id }, ctx(admin.id))).toBe(true);
    const again = await M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id } }, ctx(admin.id));
    expect(again.id).not.toBe(everyone.id);
  });

  it('an attendee outside the owner\'s context is "no match"; a foreign Channel is "no match"', async () => {
    const channel = await defaultChannel();
    const appB = await db.app.create({ data: { id: generateId(), organizationId: orgB.id, name: 'B', urn: `${orgB.urn}:b` } });
    await db.appAgent.create({ data: { appId: appB.id, agentId: agent.id } });
    const foreignWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appB.id, agentId: agent.id, name: 'Bo', slug: 'bo' } });
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id, attendeeRef: foreignWorker.id } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: app.urn, channelRef: channel.id, attendeeRef: agent2.urn } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // The stranger (orgB admin) cannot name our Channel from their App.
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: appB.urn, channelRef: channel.id } }, ctx(stranger.id)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('update changes role / mentionOnly / description under the owner gate; an org row is not the App admin\'s to remove unless they are org CONTRIBUTOR+', async () => {
    const channel = await defaultChannel();
    const orgRow = await M.createRegisterEntry({}, { input: { ownerRef: org.urn, channelRef: channel.id } }, ctx(contributor.id));
    const updated = await M.updateRegisterEntry({}, { ref: orgRow.id, input: { role: 'POST', mentionOnly: true, description: 'posters only' } }, ctx(contributor.id));
    expect(updated).toMatchObject({ role: 'POST', mentionOnly: true, description: 'posters only' });
    await expect(M.deleteRegisterEntry({}, { ref: orgRow.id }, ctx(reader.id))).rejects.toThrow(/Forbidden/);
    expect(await M.deleteRegisterEntry({}, { ref: orgRow.id }, ctx(contributor.id))).toBe(true);
  });
});

describe('reads follow the host memory or the owner side', () => {
  it('a participant reads and lists; a stranger sees null and an empty page; an owner-side reader without host access sees the row with channel: null', async () => {
    const channel = await defaultChannel();
    const install = await db.registerEntry.findFirstOrThrow({ where: { appId: app.id, deletedAt: null } });
    expect((await Q.registerEntry({}, { ref: install.id }, ctx(admin.id)))?.id).toBe(install.id);
    const page = await Q.registerEntries({}, { filter: { ownerRef: app.urn } }, ctx(admin.id));
    expect(page.total).toBe(1);
    expect((await Q.registerEntries({}, { filter: { channelRef: channel.id } }, ctx(admin.id))).total).toBe(1);
    expect((await Q.registerEntries({}, { filter: { attendeeRef: agent.urn } }, ctx(admin.id))).total).toBe(1);
    expect(await RE.attendeeUrn(install, {}, ctx(admin.id))).toBe(agent.urn);
    expect((await RE.channel(install, {}, ctx(admin.id)))?.id).toBe(channel.id);
    // Stranger: nothing, on every filter.
    expect(await Q.registerEntry({}, { ref: install.id }, ctx(stranger.id))).toBeNull();
    expect((await Q.registerEntries({}, { filter: { ownerRef: app.urn } }, ctx(stranger.id))).total).toBe(0);
    expect((await Q.registerEntries({}, { filter: { channelRef: channel.id } }, ctx(stranger.id))).total).toBe(0);
    expect((await Q.registerEntries({}, { filter: { attendeeRef: worker.id } }, ctx(stranger.id))).total).toBe(0);
    // An org READER is on the owner side of an ORG row but cannot read the
    // App's host memory: the row is visible, its Channel is not.
    const orgRow = await M.createRegisterEntry({}, { input: { ownerRef: org.urn, channelRef: channel.id } }, ctx(contributor.id));
    expect((await Q.registerEntry({}, { ref: orgRow.id }, ctx(reader.id)))?.id).toBe(orgRow.id);
    expect(await RE.channel(orgRow, {}, ctx(reader.id))).toBeNull();
    expect(await Q.registerEntry({}, { ref: install.id }, ctx(reader.id))).toBeNull();
  });
});

describe('#1171 — the Channel address on the register surface', () => {
  it('creates and filters by the address; an address naming nothing gets the refusal a foreign id already got', async () => {
    const channel = await defaultChannel();
    const address = `hrn:node:${appMem.urn}:chats:team`;
    const row = await M.createRegisterEntry(
      {},
      { input: { ownerRef: org.urn, channelRef: address, attendeeRef: worker.id, role: 'WATCH' } },
      ctx(contributor.id),
    );
    expect(row.channelId).toBe(channel.id);
    // The filter takes it too — a list argument and a write argument must not
    // disagree about what an address is.
    expect((await Q.registerEntries({}, { filter: { channelRef: address } }, ctx(admin.id))).total).toBe(
      (await Q.registerEntries({}, { filter: { channelRef: channel.id } }, ctx(admin.id))).total,
    );
    // Naming nothing: refused on the write, an empty page on the list — each
    // the shape that surface already had for a foreign id (no new disclosure).
    await expect(
      M.createRegisterEntry({}, { input: { ownerRef: org.urn, channelRef: `hrn:node:${appMem.urn}:chats:absent` } }, ctx(contributor.id)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect((await Q.registerEntries({}, { filter: { channelRef: `hrn:node:${appMem.urn}:chats:absent` } }, ctx(admin.id))).total).toBe(0);
    expect((await Q.registerEntries({}, { filter: { channelRef: address } }, ctx(stranger.id))).total).toBe(0);
  });
});
