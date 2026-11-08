/**
 * #3455: a no-spend due-wake preview on the GraphQL `dueWakes` read (`preview: true`).
 *
 * The gate (Xabat, #3455): a `preview` argument on the existing field, default false = today's behaviour. A preview
 * reserves nothing, counts no budget use and never triggers the day's notice; it is still an App-key read, so it is
 * recorded (cor:agt:080:22); reach and refusals are those of `dueWakes` (host key: its host's workers only; non-host
 * key: unhosted workers only; session-bound key: refused, cor:aut:010:04).
 *
 * Two things the gate does not spell out and the pins hold (builder's reading, raised on the task):
 *   - the internal `preview` flag is the PLATFORM's read (the dark-worker alarm): it skips the caller's memory and task
 *     reading rights. A caller's preview must not inherit that, so the answer is the same as the spending read's;
 *   - a preview's `proof` must not be acknowledgeable: acknowledging a proof with no reservation still records a delivery
 *     receipt and charges the day's budget, which would make the preview spend after all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../../api/graphql/schema/resolvers.teamChat.js';
import { registerHost } from '../agentTasks/hosts.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const HOST = 'hx';

type World = {
  orgId: string; appId: string; userId: string; agentId: string; keyId: string; hostKeyId: string;
  channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
  workers: Array<{ id: string; slug: string }>;
};
let w: World;
let post: ReturnType<typeof vi.spyOn>;

const keyCtx = (keyId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], appId: w.appId, appKeyId: keyId, organizationId: w.orgId, ...extra }) as Context;
const codeOf = (e: unknown) => (e as { extensions?: { code?: string } } | null)?.extensions?.code;
const attempt = async <T>(p: () => Promise<T>) => p().then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));

async function build(opts: { workers: number; budget: number }): Promise<void> {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { name: 'preview3455', urn: `p3455-${suffix}.example` } });
  const user = await db.user.create({ data: { githubId: 3455001, githubUsername: `p3455-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Role', urn: `${org.urn}:role`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, wakeDailyBudget: opts.budget } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const memory = await db.memory.create({ data: { organizationId: org.id, urn: `${org.urn}:shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'chats:team', createdBy: user.id });
  const channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  const workers: World['workers'] = [];
  for (let n = 0; n < opts.workers; n++) {
    const id = generateId();
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId: app.id, agentId: agent.id, name: `W${n}`, slug: `w${n}`, heldByUserId: user.id, heldAt: new Date() } });
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: id, role: 'BOTH' } });
    workers.push({ id, slug: `w${n}` });
  }
  const mkKey = async (host: boolean) => {
    const id = generateId();
    const key = await db.appKey.create({ data: { appId: app.id, label: host ? 'host reader' : 'wake reader', keyHash: id, keyPreview: id.slice(-4) } });
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: user.id } });
    if (host) await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'host:operate', hostId: HOST, grantedByUserId: user.id } });
    return key.id;
  };
  w = { orgId: org.id, appId: app.id, userId: user.id, agentId: agent.id, channel, workers, keyId: await mkKey(false), hostKeyId: await mkKey(true) };
}

async function mention(...slugs: string[]) {
  const enc = await getMemoryEncryptionInfo(db, w.channel.memoryId);
  return appendChatMessage(db, { id: w.channel.chatRootNodeId, memoryId: w.channel.memoryId, loc: w.channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: w.channel.memoryId, loc: `${w.channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq,
      messageChannelId: w.channel.id, content: 'hi', data: { mentions: slugs } } }), { asChannel: true });
}
const read = (c: Context, preview?: boolean) => Q.dueWakes({}, { appRef: w.appId, ...(preview === undefined ? {} : { preview }) }, c);
const reservations = () => db.appWakeReservation.count({ where: { appId: w.appId } });
const spent = async () => (await db.appWakeDay.findMany({ where: { appId: w.appId } })).reduce((n, d) => n + d.wakes, 0);
const noticePosted = async () => (await db.appWakeDay.count({ where: { appId: w.appId, noticePostedAt: { not: null } } })) > 0;
const readRecords = (keyId: string) => db.appKeyWakeRead.count({ where: { appKeyId: keyId } });
const slugsOf = (page: { wakes: Array<{ worker: { slug: string } }> }) => page.wakes.map((x) => x.worker.slug).sort();

beforeEach(() => { post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never); });
afterEach(() => post.mockRestore());

describe('#3455: a preview read reserves nothing and spends nothing', () => {
  it('control: a normal read of a due worker reserves its wake, as before', async () => {
    await build({ workers: 1, budget: 5 });
    await mention('w0');
    const page = await read(keyCtx(w.keyId));
    expect(slugsOf(page)).toEqual(['w0']);
    expect(await reservations()).toBe(1);
  });

  it('a preview of the same state returns the same wake and leaves reservations and the day count unchanged', async () => {
    await build({ workers: 1, budget: 5 });
    await mention('w0');
    const normal = await read(keyCtx(w.keyId));
    await db.appWakeReservation.deleteMany({ where: { appId: w.appId } });
    const preview = await read(keyCtx(w.keyId), true);
    expect(slugsOf(preview)).toEqual(['w0']);
    // The same answer, field for field, but for the proof.
    const strip = (p: any) => p.wakes.map((x: any) => ({ s: x.worker.slug, r: x.reasons.map((q: any) => q.kind), c: x.channels.map((c: any) => [c.fromSeq, c.throughSeq]), u: x.unread, m: x.unreadMentions }));
    expect(strip(preview)).toEqual(strip(normal));
    expect(await reservations()).toBe(0);
    expect(await spent()).toBe(0);
  });

  it('a preview of a spent budget withholds nothing and posts no notice, where the normal read posts it', async () => {
    await build({ workers: 2, budget: 1 });
    await mention('w0', 'w1');
    const preview = await read(keyCtx(w.keyId), true);
    expect(preview.withheld).toBe(0);
    expect(slugsOf(preview)).toEqual(['w0', 'w1']);
    expect(await noticePosted()).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(await reservations()).toBe(0);
    // Control: the normal read of the same state does withhold and notify.
    const normal = await read(keyCtx(w.keyId));
    expect(normal.withheld).toBe(1);
    expect(await noticePosted()).toBe(true);
  });

  it('a preview omitted or false is the spending read', async () => {
    await build({ workers: 1, budget: 5 });
    await mention('w0');
    await read(keyCtx(w.keyId), false);
    expect(await reservations()).toBe(1);
  });
});

describe('#3455: a preview is still an App-key read (cor:agt:080:22)', () => {
  it('records which key, how many workers, when', async () => {
    await build({ workers: 2, budget: 5 });
    await mention('w0', 'w1');
    await read(keyCtx(w.keyId), true);
    expect(await readRecords(w.keyId)).toBe(1);
    const row = await db.appKeyWakeRead.findFirstOrThrow({ where: { appKeyId: w.keyId } });
    expect(row.workerCount).toBe(2);
  });
});

describe('#3455: a preview has the reach and refusals of dueWakes', () => {
  it('a host key previews only its own host\'s workers; a non-host key only the unhosted', async () => {
    await build({ workers: 2, budget: 5 });
    await registerHost(db, { appId: w.appId, hostId: HOST, label: HOST, pollIntervalSeconds: 600, workers: [{ workerId: w.workers[0]!.id, family: 'claude' }] });
    await mention('w0', 'w1');
    expect(slugsOf(await read(keyCtx(w.hostKeyId), true))).toEqual(['w0']);
    expect(slugsOf(await read(keyCtx(w.keyId), true))).toEqual(['w1']);
    expect(await reservations()).toBe(0);
  });

  it('a session-bound key is refused, a key without the scope is refused, a foreign App is concealed', async () => {
    await build({ workers: 1, budget: 5 });
    await mention('w0');
    const bound = await attempt(() => read(keyCtx(w.keyId, { sessionId: generateId() }), true));
    expect(bound.value).toBeNull();
    expect(bound.error).toBeTruthy();
    await db.appKeyScope.deleteMany({ where: { appKeyId: w.keyId } });
    const noScope = await attempt(() => read(keyCtx(w.keyId), true));
    expect(noScope.value).toBeNull();
    expect(noScope.error).toBeTruthy();
    expect(await readRecords(w.keyId)).toBe(0);
    expect(await reservations()).toBe(0);
  });
});

describe('#3455: a preview never lets the caller read more than the spending read does', () => {
  it('a worker watching a channel whose memory the key cannot read is not counted in a preview either', async () => {
    await build({ workers: 1, budget: 5 });
    // A channel in a memory of ANOTHER App of the same org: not the key App's to read.
    const other = await db.app.create({ data: { organizationId: w.orgId, name: 'Other', urn: `o-${generateId()}.example:other` } });
    const mem = await db.memory.create({ data: { organizationId: w.orgId, urn: `${generateId()}.example:hidden`, name: 'hidden', class: 'app', appId: other.id, sharedMemoryOfAgentId: w.agentId } });
    const made = await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:hidden', name: 'chats:hidden', createdBy: w.userId });
    await db.registerEntry.create({ data: { id: generateId(), appId: w.appId, channelId: made.channel.id, attendeeWorkerId: w.workers[0]!.id, role: 'BOTH' } });
    const enc = await getMemoryEncryptionInfo(db, mem.id);
    await appendChatMessage(db, { id: made.rootId, memoryId: mem.id, loc: 'chats:hidden' }, enc, async ({ tx, seq, msgNum }) =>
      tx.node.create({ data: { id: generateId(), memoryId: mem.id, loc: `chats:hidden:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq,
        messageChannelId: made.channel.id, content: 'secret', data: { mentions: ['w0'] } } }), { asChannel: true });
    const normal = await read(keyCtx(w.keyId));
    await db.appWakeReservation.deleteMany({ where: { appId: w.appId } });
    const preview = await read(keyCtx(w.keyId), true);
    expect(slugsOf(preview)).toEqual(slugsOf(normal));
    expect(preview.wakes.map((x: any) => x.channels.length)).toEqual(normal.wakes.map((x: any) => x.channels.length));
  });
});

describe('#3455: a preview proof cannot be acknowledged, so the preview cannot spend by that road', () => {
  it('acknowledging what a preview returned is refused and records nothing, counts nothing', async () => {
    await build({ workers: 1, budget: 5 });
    await mention('w0');
    const preview = await read(keyCtx(w.keyId), true);
    const proofs = preview.wakes.map((x: any) => x.proof);
    expect(proofs).toHaveLength(1);
    const ack = await attempt(() => M.acknowledgeWakes({}, { proofs }, keyCtx(w.keyId)));
    expect(ack.value).toBeNull();
    expect(codeOf(ack.error)).toBe('WAKE_PROOF_INVALID');
    expect(await spent()).toBe(0);
    expect(await db.workerWakeAck.count({ where: { workerId: w.workers[0]!.id } })).toBe(0);
    // Control: the proof of a normal read is acknowledged and counted once.
    const normal = await read(keyCtx(w.keyId));
    const okAck = await M.acknowledgeWakes({}, { proofs: normal.wakes.map((x: any) => x.proof) }, keyCtx(w.keyId));
    expect(okAck.acknowledged).toBe(1);
    expect(await spent()).toBe(1);
  });
});

describe('#3455: a preview that lists STOP does not declare a serving consumer', () => {
  it('no stop-lane declaration is written by a preview, one is by the spending read', async () => {
    await build({ workers: 1, budget: 5 });
    const before = await db.stopConsumerDeclaration.count({ where: { appId: w.appId } });
    await Q.dueWakes({}, { appRef: w.appId, accepts: ['STOP'], preview: true }, keyCtx(w.keyId));
    expect(await db.stopConsumerDeclaration.count({ where: { appId: w.appId } })).toBe(before);
    await Q.dueWakes({}, { appRef: w.appId, accepts: ['STOP'] }, keyCtx(w.keyId));
    expect(await db.stopConsumerDeclaration.count({ where: { appId: w.appId } })).toBe(before + 1);
  });
});

describe('#3455 (Vera, cor:agt:090:04): a STOP notice a preview shows is still offered to the next declaring consumer', () => {
  it('a preview lists the notice and consumes nothing; the spending read then offers it and its proof acknowledges', async () => {
    await build({ workers: 1, budget: 5 });
    const manager = { db, roles: [], userId: w.userId, organizationId: w.orgId } as unknown as Context;
    await declareAllStopLanes(db, w.appId);
    const sig = await M.setTeamStopSignal({}, { input: { appRef: w.appId, level: 'HALT', scope: 'WORKER', worker: w.workers[0]!.id } }, manager);
    const kinds = (p: any) => p.wakes.flatMap((x: any) => x.reasons.map((r: any) => r.kind));
    const preview = await Q.dueWakes({}, { appRef: w.appId, accepts: ['STOP'], preview: true }, manager);
    expect(kinds(preview)).toEqual(['STOP']);
    expect(preview.wakes[0].reasons[0].stop.signalId).toBe(sig.id);
    expect(await reservations()).toBe(0);
    // Offered again, to a real consumer, as if the preview had not happened.
    const real = await Q.dueWakes({}, { appRef: w.appId, accepts: ['STOP'] }, manager);
    expect(kinds(real)).toEqual(['STOP']);
    expect(real.wakes[0].reasons[0].stop.signalId).toBe(sig.id);
    const ack = await M.acknowledgeWakes({}, { proofs: [real.wakes[0].proof] }, manager);
    expect(ack.acknowledged).toBe(1);
  });
});
