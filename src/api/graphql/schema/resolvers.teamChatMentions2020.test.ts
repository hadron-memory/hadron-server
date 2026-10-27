import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2020 (S4 of epic #2016) — a worker's mentions read and its mention counts
 * return exactly the messages that REACH it: its own name (replies folded in at
 * post time), plus a broadcast (`@all`, bare `@team`) the server stamped
 * `broadcastWakes` when it was posted (cor:agt:080:14). Never the worker's own
 * post; never an unstamped broadcast; never re-decided from today's roles.
 *
 * Every stamp below comes from the real post path (`createTeamChatMessage` →
 * `wakeStampsFor`), except the legacy-shape rows, which are the point.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { getMemoryEncryptionInfo, encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { teamAttentionPage } from '../../../lib/teamAttention.js';
import { resolvers, type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;

type W = { id: string; name: string; holder: string; session: string };

let org: { id: string; urn: string };
let manager: { id: string };
let holderA: { id: string };
let holderB: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let liam: W;
let rook: W;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_200 + n, githubUsername: `mr-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkWorker(name: string, holder: string): Promise<W> {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder, heldAt: new Date() }, select: { id: true, name: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
  return { ...w, holder, session: session.id };
}
const grant = (workerId: string) =>
  db.appGrant.create({ data: { id: generateId(), appId: app.id, granteeWorkerId: workerId, name: 'ticker.subscribe-workers', grantedBy: manager.id } });

/** A human posting as themselves (no session). */
const humanSays = (userId: string, body: string, replyToSeq: number | null = null) =>
  teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq, sessionRef: null }, ctx(userId));
/** A worker posting through its own session. */
const workerSays = (w: W, body: string, replyToSeq: number | null = null) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () =>
    teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq, sessionRef: w.session }, ctx(w.holder)));
/** A row written with an exact stored envelope — the legacy and malformed shapes. */
async function rawRow(data: Record<string, unknown>) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  const r = await appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: 'raw', data: data as never } }),
    { asChannel: true });
  return (await db.node.findUniqueOrThrow({ where: { id: r.inserted.id }, select: { seq: true } })).seq!;
}

/** The seqs a worker's mentions read returns (the CLI's `--mentions-me` sends the worker id). */
async function mentionsOf(w: W, extra: Record<string, unknown> = {}): Promise<number[]> {
  const page = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: w.id, ...extra }, ctx(w.holder));
  expect(page.total).toBe(page.items.length);
  return page.items.map((m: any) => m.seq);
}
/** The attention scan's mention count for one worker (the Orca router's number). */
async function attentionMentions(w: W): Promise<number> {
  let n = 0;
  for (let page: string | null = null, guard = 0; guard < 50; guard++) {
    const r: any = await teamAttentionPage(ctx(w.holder), app.id, { since: null, page });
    for (const item of r.items) if (item.worker === w.id) n += item.unreadMentions;
    if (r.scanComplete || !r.nextPage) break;
    page = r.nextPage;
  }
  return n;
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'mr-org', urn: `mr-org-${suffix}.com` } });
  [manager, holderA, holderB] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [holderA, holderB]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  liam = await mkWorker('Liam', holderA.id);
  rook = await mkWorker('Rook', holderB.id);
});

describe('a stamped broadcast reaches every worker (the #20231 red)', () => {
  it('a manager\'s @all is on every worker\'s mentions read and counts as a mention', async () => {
    const m = await humanSays(manager.id, 'host shutdown in 10 minutes @all');
    expect(m.mentions).toEqual(['all']);
    expect(await mentionsOf(liam)).toEqual([m.seq]);
    expect(await mentionsOf(rook)).toEqual([m.seq]);
    expect(await attentionMentions(liam)).toBe(1);
  });

  it('a grant holder\'s @all reaches the others, never its author', async () => {
    await grant(liam.id);
    const m = await workerSays(liam, 'standup @all');
    expect(await mentionsOf(rook)).toEqual([m.seq]);
    expect(await mentionsOf(liam)).toEqual([]);
  });

  it('bare @team is a broadcast like @all; @team.all is not one yet (S3)', async () => {
    const team = await humanSays(manager.id, 'retro @team');
    const dotted = await humanSays(manager.id, 'later @team.all');
    expect(await mentionsOf(liam)).toEqual([team.seq]);
    expect(dotted.seq).toBeGreaterThan(team.seq);
  });
});

describe('an unstamped broadcast is ordinary unread, not a mention', () => {
  it('a plain worker\'s @all reaches nobody\'s mentions, and the router does not count it as one', async () => {
    const m = await workerSays(rook, 'quoting the @all token');
    expect(m.mentions).toEqual(['all']);
    expect(await mentionsOf(liam)).toEqual([]);
    expect(await attentionMentions(liam)).toBe(0);
  });

  it('a plain member\'s @all and @team are not mentions either', async () => {
    await humanSays(holderB.id, 'hey @all');
    await humanSays(holderB.id, 'hey @team');
    expect(await mentionsOf(liam)).toEqual([]);
    expect(await attentionMentions(liam)).toBe(0);
  });
});

describe('names, replies and own posts', () => {
  it('an explicit name reaches that worker only; an untagged reply reaches the replied-to worker', async () => {
    const direct = await humanSays(manager.id, '@liam please review');
    const q = await workerSays(liam, 'a question');
    const reply = await workerSays(rook, 'an answer', q.seq);
    expect(await mentionsOf(liam)).toEqual([direct.seq, reply.seq]);
    expect(await mentionsOf(rook)).toEqual([]);
  });

  it('a worker\'s own post never reaches it, a self-mention included', async () => {
    const self = await workerSays(liam, 'note to @liam');
    expect(self.mentions).toEqual(['liam']);
    expect(await mentionsOf(liam)).toEqual([]);
    expect(await attentionMentions(liam)).toBe(0);
  });
});

describe('a worker whose name yields no mention token (Riana §10 P2)', () => {
  it('addressed by id, it still sees stamped broadcasts, never unstamped ones or its own', async () => {
    const bang = await mkWorker('!!!', holderA.id);
    await grant(bang.id);
    const stamped = await humanSays(manager.id, 'host shutdown @all');
    await workerSays(rook, 'quoting @all');
    await workerSays(bang, 'its own @all');
    expect(await mentionsOf(bang)).toEqual([stamped.seq]);
    expect(await attentionMentions(bang)).toBe(1);
  });
});

describe('decided at post time (cor:agt:080:14)', () => {
  it('revoking the grant and releasing the worker after the post leaves the broadcast on the read', async () => {
    const g = await grant(liam.id);
    const m = await workerSays(liam, 'deploy freeze @all');
    await db.appGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
    await db.worker.update({ where: { id: liam.id }, data: { heldByUserId: null, heldAt: null } });
    expect(await mentionsOf(rook)).toEqual([m.seq]);
  });

  it('a manager demoted after posting still reached everyone', async () => {
    const m = await humanSays(manager.id, 'all hands @all');
    await db.orgMember.updateMany({ where: { userId: manager.id }, data: { role: 'CONTRIBUTOR' } });
    expect(await mentionsOf(liam)).toEqual([m.seq]);
  });

  it('a worker granted the right after posting does not reach anyone with the earlier post', async () => {
    await workerSays(rook, 'early @all');
    await grant(rook.id);
    expect(await mentionsOf(liam)).toEqual([]);
  });
});

describe('legacy and malformed stamps', () => {
  it('only a strictly boolean true stamp qualifies', async () => {
    await rawRow({ mentions: ['all'] });
    await rawRow({ mentions: ['all'], broadcastWakes: null });
    await rawRow({ mentions: ['all'], broadcastWakes: 'true' });
    await rawRow({ mentions: 'all', broadcastWakes: true });
    const ok = await rawRow({ mentions: ['all'], broadcastWakes: true });
    expect(await mentionsOf(liam)).toEqual([ok]);
    expect(await attentionMentions(liam)).toBe(1);
  });
});

describe('the gates the read had stay as they were', () => {
  it('a foreign App\'s worker, a non-member and the literal "all" read as the empty page', async () => {
    await humanSays(manager.id, 'everyone @all');
    const page = (ref: string) => Q.teamChatMessages({}, { appRef: app.id, mentionsRef: ref }, ctx(holderA.id));
    expect(await page('all')).toMatchObject({ items: [], total: 0 });
    const outsider = await mkUser(9);
    expect(await page(outsider.id)).toMatchObject({ items: [], total: 0 });
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'o', urn: `o-${Date.now()}.example` } });
    const otherApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Other', urn: `${otherOrg.urn}:other` } });
    const otherAgent = await db.agent.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Ghost', urn: `${otherOrg.urn}:ghost` } });
    const foreign = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: otherAgent.id, name: 'Liam', slug: 'liam' } });
    expect(await page(foreign.id)).toMatchObject({ items: [], total: 0 });
  });

  it('a user ref still matches the handle alone: a broadcast is not a user\'s mention', async () => {
    const handle = `hb-${Date.now()}`;
    await db.user.update({ where: { id: holderB.id }, data: { handle } });
    await humanSays(manager.id, 'everyone @all');
    const named = await humanSays(manager.id, `thanks @${handle}`);
    const page = await Q.teamChatMessages({}, { appRef: app.id, mentionsRef: holderB.id }, ctx(holderB.id));
    expect(page.items.map((m: any) => m.seq)).toEqual([named.seq]);
  });
});

describe('an encrypted team chat', () => {
  async function encrypt(): Promise<void> {
    const key = generateDataKey();
    sessionKeyCache.set('mr-2020', memory.id, key);
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    for (const m of await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' } })) {
      const enc = encryptNodeFieldsWithKey({ content: m.content ?? null, data: (m.data ?? null) as unknown }, key);
      await db.node.update({ where: { id: m.id }, data: { content: enc.content ?? null, data: enc.data as never } });
    }
  }

  it('the stamp sealed in the envelope decides, on the read and the count', async () => {
    const stamped = await humanSays(manager.id, 'drill @all');
    await workerSays(rook, 'quoting @all');
    await workerSays(liam, 'note to @liam');
    await encrypt();
    const sealed = await db.node.findMany({ where: { memoryId: memory.id, nodeType: 'chat-message' }, select: { data: true } });
    for (const s of sealed) expect(s.data).toHaveProperty('__enc');
    expect(await mentionsOf(liam)).toEqual([stamped.seq]);
    expect(await attentionMentions(liam)).toBe(1);
    sessionKeyCache.evict('mr-2020');
  });
});

describe('one eligibility set (every wake gate open)', () => {
  const due = async (): Promise<string[]> => {
    const page = await Q.dueWakes({}, { appRef: app.id }, ctx(manager.id));
    return page.wakes.map((w: any) => w.worker.id).sort();
  };
  const reached = async (ws: W[]): Promise<string[]> =>
    (await Promise.all(ws.map(async (w) => ((await mentionsOf(w)).length > 0 ? w.id : null)))).filter((x): x is string => !!x).sort();

  it('an unstamped broadcast and a name: the read, the count and the due set name the same worker', async () => {
    const nova = await mkWorker('Nova', holderA.id);
    await workerSays(rook, 'quoting @all');
    await humanSays(manager.id, '@nova over to you');
    const all = [liam, rook, nova];
    expect(await reached(all)).toEqual([nova.id]);
    expect(await attentionMentions(nova)).toBe(1);
    expect(await attentionMentions(liam)).toBe(0);
    expect(await due()).toEqual([nova.id]);
  });

  it('a stamped broadcast: all three sets name every other worker', async () => {
    const nova = await mkWorker('Nova', holderA.id);
    await humanSays(manager.id, 'all hands @all');
    const all = [liam, rook, nova];
    expect(await reached(all)).toEqual(all.map((w) => w.id).sort());
    expect(await due()).toEqual(all.map((w) => w.id).sort());
  });

  it('closing a wake gate changes when, never what: mentions OFF and a pause leave the read unchanged', async () => {
    await db.workerWakeSettings.create({ data: { workerId: liam.id, mentions: 'OFF' } });
    await db.workerWakeSettings.create({ data: { workerId: rook.id, pausedUntil: new Date(Date.now() + 3600_000) } });
    const m = await humanSays(manager.id, 'all hands @all');
    expect(await due()).toEqual([]);
    expect(await mentionsOf(liam)).toEqual([m.seq]);
    expect(await mentionsOf(rook)).toEqual([m.seq]);
  });
});


afterEach(() => vi.unstubAllEnvs());
describe('S3 real post/filter/history integration', () => {
  it('stamps a head/subtree without global authority and filters before paging', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED', 'true');
    const { writeReportsTo } = await import('../../../lib/workerReportsTo.js');
    await db.$transaction(tx => writeReportsTo(tx, { appId: app.id, workerId: liam.id, to: rook.id, actor: { userId: manager.id, workerId: null, agentId: null }, setBy: 'app-manager' }));
    const outsider = await mkWorker('Solo', holderA.id);
    const post = await humanSays(holderA.id, '@team.rook.all @all');
    expect(post.broadcastWakes).toBe(false);
    expect(post.teamBroadcastWorkerIds?.sort()).toEqual([liam.id, rook.id].sort());
    expect(post.teamTags).toEqual([{headId: rook.id, label: '@team.rook'}]);
    expect(await mentionsOf(liam)).toEqual([post.seq]);
    expect(await attentionMentions(liam)).toBe(1);
    expect(await mentionsOf(outsider)).toEqual([]);
    expect(await attentionMentions(outsider)).toBe(0);
    const page = await Q.teamChatMessages({}, {appRef: app.id, teamHeadRef: rook.id, limit: 0}, ctx(holderA.id));
    expect(page).toMatchObject({items: [], total: 1});
    expect((await Q.teamChatMessages({}, {appRef: app.id, untagged: true}, ctx(holderA.id))).total).toBe(0);
    await db.channelReadState.create({data:{id:generateId(),workerId:liam.id,appId:app.id,channelId:channel.id,lastSeenSeq:0}});
    await Q.teamChatMessages({}, {appRef:app.id,sinceSeq:0,teamHeadRef:rook.id,advanceReadState:true},ctx(holderA.id,{sessionId:liam.session}));
    expect((await db.channelReadState.findFirstOrThrow({where:{workerId:liam.id,channelId:channel.id}})).lastSeenSeq).toBe(0);
  });
  it('preserves absent/empty and legacy reach through ON and rollback; invalid heads roll back allocation', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED', 'false');
    const old = await humanSays(manager.id, '@team legacy');
    vi.stubEnv('TEAM_TAGS_ENABLED', 'true');
    const modern = await humanSays(manager.id, '@team modern');
    expect(modern.teamTags).toEqual([]);
    const before = await db.channel.findUniqueOrThrow({where: {id: channel.id}});
    await expect(humanSays(holderA.id, '@team.missing.all')).rejects.toMatchObject({extensions: {code: 'TEAM_CHAT_TEAM_HEAD_INVALID'}});
    expect((await db.channel.findUniqueOrThrow({where: {id: channel.id}})).lastSeq).toBe(before.lastSeq);
    for (const mode of ['true', 'false']) {
      vi.stubEnv('TEAM_TAGS_ENABLED', mode);
      expect(await mentionsOf(liam)).toEqual([old.seq]);
      const page = await Q.teamChatMessages({}, {appRef: app.id, untagged: true}, ctx(holderA.id));
      expect(page.items.map((m: any) => m.teamTags)).toEqual([null, []]);
    }
  });
});


describe('S3 filter audience and transport boundaries', () => {
  it('refuses incompatible or foreign head filters before returning count/page', async () => {
    await expect(Q.teamChatMessages({}, {appRef: app.id, teamHeadRef: rook.id, untagged: true, limit: 0}, ctx(holderA.id))).rejects.toMatchObject({extensions: {code: 'BAD_USER_INPUT'}});
    await expect(Q.teamChatMessages({}, {appRef: app.id, teamHeadRef: 'foreign-or-missing', limit: 0}, ctx(holderA.id))).rejects.toMatchObject({extensions: {code: 'TEAM_CHAT_TEAM_HEAD_INVALID'}});
  });
  it('refuses a non-head worker as teamHeadRef byte-identically; head, retired head and ex-head still read (#2592)', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED', 'true');
    const { writeReportsTo } = await import('../../../lib/workerReportsTo.js');
    const read = (ref: string) => Q.teamChatMessages({}, {appRef: app.id, teamHeadRef: ref, limit: 0}, ctx(holderA.id));
    const refusal = async (ref: string) => { try { await read(ref); } catch (e: any) { return {message: e.message, extensions: e.extensions}; } return null; };
    const missing = await refusal('no-such-worker');
    expect(missing).toMatchObject({extensions: {code: 'TEAM_CHAT_TEAM_HEAD_INVALID'}});
    // Leaf in the App: no reports, never stamped.
    expect(await refusal(liam.id)).toEqual(missing);
    // Foreign-App worker id.
    const fid = generateId();
    const foreignAgent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Foreign', urn: `${org.urn}:foreign-agent-${fid}`, visibility: 'ORGANIZATION' } });
    const foreignApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Foreign', urn: `${org.urn}:foreign-${fid}` } });
    const foreign = await db.worker.create({data: {...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: foreignApp.id, agentId: foreignAgent.id, name: 'Foreign', slug: 'foreign', heldByUserId: holderA.id, heldAt: new Date()}, select: {id: true}});
    expect(await refusal(foreign.id)).toEqual(missing);
    // A head reads.
    await db.$transaction(tx => writeReportsTo(tx, {appId: app.id, workerId: liam.id, to: rook.id, actor: {userId: manager.id, workerId: null, agentId: null}, setBy: 'app-manager'}));
    expect(await read(rook.id)).toMatchObject({items: [], total: 0});
    // A retired head whose report is still attached keeps working.
    await db.worker.update({where: {id: rook.id}, data: {retiredAt: new Date()}});
    expect(await read(rook.id)).toMatchObject({items: [], total: 0});
    await db.worker.update({where: {id: rook.id}, data: {retiredAt: null}});
    // Mutual exclusivity and the metadata-forbidden refusal keep their order ahead of the head check.
    await expect(Q.teamChatMessages({}, {appRef: app.id, teamHeadRef: liam.id, untagged: true, limit: 0}, ctx(holderA.id))).rejects.toMatchObject({extensions: {code: 'BAD_USER_INPUT'}});
  });
  it('masks metadata and denies all tag/count probes on an authorized App-less Channel', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED','true');
    const { writeReportsTo } = await import('../../../lib/workerReportsTo.js');
    await db.$transaction(tx=>writeReportsTo(tx,{appId:app.id,workerId:liam.id,to:rook.id,actor:{userId:manager.id,workerId:null,agentId:null},setBy:'app-manager'}));
    const populated = await humanSays(manager.id, 'hello @rook');
    expect(populated.teamTags).toHaveLength(1);
    await db.memory.update({where: {id: memory.id}, data: {class: 'knowledge', appId: null, sharedMemoryOfAgentId: null}});
    const page = await Q.channelMessages({}, {channelRef: channel.id}, ctx(manager.id));
    expect(page.items[0].teamTags).toBeNull();
    for (const filter of [{untagged: true}, {untagged: false}, {teamHeadRef: rook.id}]) {
      await expect(Q.channelMessages({}, {channelRef: channel.id, limit: 0, ...filter}, ctx(manager.id))).rejects.toMatchObject({extensions: {code: 'TEAM_CHAT_TEAM_METADATA_FORBIDDEN'}});
    }
  });
  it('carries nullable structured pairs through actual GraphQL and applies the MCP filter without fallback', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED', 'true');
    await humanSays(manager.id, 'known empty');
    const { graphql, buildSchema, defaultFieldResolver } = await import('graphql');
    const { typeDefs } = await import('./typeDefs.js');
    const result = await graphql({schema: buildSchema(typeDefs), fieldResolver: (parent, args, context, info) => { const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined; const fn = fields?.[info.fieldName]; return typeof fn === 'function' ? fn(parent,args,context,info) : defaultFieldResolver(parent,args,context,info); }, source: 'query($app:ID!){teamChatMessages(appRef:$app,untagged:true){total items{teamTags{headId label}}}}', variableValues: {app: app.id}, contextValue: ctx(manager.id)});
    expect(result.errors).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result.data))).toEqual({teamChatMessages:{total:1,items:[{teamTags:[]}]}});
    const { createTestableMcpServer } = await import('../../../mcp/server.js');
    const server = createTestableMcpServer({userId: manager.id, appId: app.id, roles: ['READER'], clientId: `user:${manager.id}`});
    expect(await server.callToolText('hadron_team_chat_read', {untagged:true})).toContain('known empty');
    expect(await server.callToolText('hadron_team_chat_read', {untagged:true, teamHeadRef:rook.id})).toContain('[bad_user_input]');
  });
});


describe('S3 bare @team retirement is the switch, nothing else (#2019)', () => {
  it('a manager\'s bare @team keeps its stamped reach OFF and stops broadcasting ON; @all is unchanged by the switch', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED', 'false');
    const off = await humanSays(manager.id, 'retro @team');
    expect(off.broadcastWakes).toBe(true);
    expect(await mentionsOf(liam)).toEqual([off.seq]);
    vi.stubEnv('TEAM_TAGS_ENABLED', 'true');
    const on = await humanSays(manager.id, 'retro again @team');
    expect(on.broadcastWakes).toBe(false);
    const global = await humanSays(manager.id, 'all hands @all');
    expect(global.broadcastWakes).toBe(true);
    // Rolling back leaves the ON-era bare @team without global reach.
    vi.stubEnv('TEAM_TAGS_ENABLED', 'false');
    expect(await mentionsOf(liam)).toEqual([off.seq, global.seq]);
  });
});

describe('S3 graph snapshot concurrency', () => {
  it('waits for a graph writer and stamps the committed nearest team rather than its stale input', async () => {
    vi.stubEnv('TEAM_TAGS_ENABLED','true');
    const { writeReportsTo } = await import('../../../lib/workerReportsTo.js');
    const { waitForLockWaiters } = await import('../../../test/lockWait.js');
    let unlock!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => {ready=resolve;});
    const gate = new Promise<void>(resolve => {unlock=resolve;});
    const writer = db.$transaction(async tx => {
      await writeReportsTo(tx,{appId:app.id,workerId:liam.id,to:rook.id,actor:{userId:manager.id,workerId:null,agentId:null},setBy:'app-manager'});
      ready(); await gate;
    },{timeout:20000});
    await held;
    const posting = workerSays(liam,'snapshot after reparent');
    try { await waitForLockWaiters(db,1,3000); } finally {unlock();}
    await writer;
    const message = await posting;
    expect(message.teamTags).toEqual([{headId:rook.id,label:'@team.rook'}]);
    await db.$transaction(tx=>writeReportsTo(tx,{appId:app.id,workerId:liam.id,to:null,actor:{userId:manager.id,workerId:null,agentId:null},setBy:'app-manager'}));
    const old = await Q.teamChatMessages({}, {appRef:app.id,teamHeadRef:rook.id},ctx(manager.id));
    expect(old.items.map((m:any)=>m.seq)).toEqual([message.seq]);
    expect(old.items[0].teamTags).toEqual(message.teamTags);
  });
});

it('S3 refuses atomically if App uninstall wins before the early graph bracket', async () => {
  vi.stubEnv('TEAM_TAGS_ENABLED','true');
  const { lockAuthorityAnchors } = await import('../../../lib/auth/authorityAnchors.js');
  const { waitForLockWaiters } = await import('../../../test/lockWait.js');
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>(resolve=>{ready=resolve;});
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const writer = db.$transaction(async tx=>{
    await lockAuthorityAnchors(tx,[{kind:'app',id:app.id}],'exclusive');
    await tx.app.update({where:{id:app.id},data:{uninstalledAt:new Date()}});
    ready(); await gate;
  },{timeout:20000});
  await held;
  const outcome = humanSays(manager.id,'must not append').then(value=>({value,error:null}),error=>({value:null,error}));
  try {await waitForLockWaiters(db,1,3000);} finally {release();}
  await writer;
  expect((await outcome).error).toMatchObject({extensions:{code:'APP_UNINSTALLED'}});
  expect(await db.node.count({where:{messageChannelId:channel.id,nodeType:'chat-message'}})).toBe(0);
  expect((await db.channel.findUniqueOrThrow({where:{id:channel.id}})).lastSeq).toBe(0);
});
