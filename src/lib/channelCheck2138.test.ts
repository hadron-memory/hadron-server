/** #2138 §3.1: stampChannelCheck — a check is recorded on the worker's own read-state row of its App's team channel, and only there. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { stampChannelCheck, stampTeamChannelChecks } from './channelReadState.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';

vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const id = (n: number) => n.toString(16).padStart(32, '0');
const [org, agent, appA, appB, memA, memB, rootA, teamA, otherA, teamB, workerA, workerA2, workerB] =
  [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(id);

beforeEach(async () => {
  await cleanDb(db);
  await db.organization.create({ data: { id: org, name: 'Checks', urn: 'checks.example' } });
  await db.agent.create({ data: { id: agent, organizationId: org, name: 'Checks role', urn: 'checks.example:role', visibility: 'ORGANIZATION' } });
  for (const [a, m] of [[appA, memA], [appB, memB]] as const) {
    await db.app.create({ data: { id: a, organizationId: org, name: `App ${a.slice(-1)}`, urn: `checks.example:app${a.slice(-1)}` } });
    await db.appAgent.create({ data: { appId: a, agentId: agent } });
    await db.memory.create({ data: { id: m, organizationId: org, name: `Host ${m.slice(-1)}`, urn: `checks.example:mem${m.slice(-1)}`, class: 'app', appId: a, sharedMemoryOfAgentId: agent } });
  }
  await db.node.create({ data: { id: rootA, memoryId: memA, loc: 'chats:team', name: 'Team', nodeType: 'chat' } });
  await db.channel.create({ data: { id: teamA, memoryId: memA, loc: 'chats:team', name: 'Team', chatRootNodeId: rootA } });
  await db.node.create({ data: { id: id(20), memoryId: memA, loc: 'chats:other', name: 'Other', nodeType: 'chat' } });
  await db.channel.create({ data: { id: otherA, memoryId: memA, loc: 'chats:other', name: 'Other', chatRootNodeId: id(20) } });
  await db.node.create({ data: { id: id(21), memoryId: memB, loc: 'chats:team', name: 'Team', nodeType: 'chat' } });
  await db.channel.create({ data: { id: teamB, memoryId: memB, loc: 'chats:team', name: 'Team', chatRootNodeId: id(21) } });
  for (const [w, a] of [[workerA, appA], [workerA2, appA], [workerB, appB]] as const) {
    await db.worker.create({ data: { id: w, appId: a, agentId: agent, name: `W${w.slice(-2)}`, slug: `w${w.slice(-2)}`, ...WORKER_SIGNATURE_DEFAULTS } });
  }
});

const checked = async (w: string, c: string) => (await db.channelReadState.findFirst({ where: { workerId: w, channelId: c } }))?.lastCheckedAt ?? null;

describe('stampChannelCheck', () => {
  it('creates the worker row at seq 0 on its first check and moves lastCheckedAt on a repeat, never lastSeenSeq', async () => {
    expect(await stampChannelCheck(db, workerA, teamA)).toBe(true);
    const first = await checked(workerA, teamA);
    expect(first).toBeInstanceOf(Date);
    expect((await db.channelReadState.findFirstOrThrow({ where: { workerId: workerA, channelId: teamA } })).lastSeenSeq).toBe(0);
    await db.channelReadState.updateMany({ where: { workerId: workerA }, data: { lastSeenSeq: 7, lastCheckedAt: new Date('2026-01-01T00:00:00Z') } });
    expect(await stampChannelCheck(db, workerA, teamA)).toBe(true);
    const row = await db.channelReadState.findFirstOrThrow({ where: { workerId: workerA, channelId: teamA } });
    expect(row.lastSeenSeq).toBe(7);
    expect(row.lastCheckedAt!.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('stamps only the named worker: another worker of the App is untouched', async () => {
    await stampChannelCheck(db, workerA, teamA);
    expect(await checked(workerA2, teamA)).toBeNull();
  });

  it('does not count a read of another channel', async () => {
    expect(await stampChannelCheck(db, workerA, otherA)).toBe(false);
    expect(await checked(workerA, otherA)).toBeNull();
  });

  it("does not count another App's team channel, nor a retired worker, nor a deleted channel", async () => {
    expect(await stampChannelCheck(db, workerA, teamB)).toBe(false);
    expect(await checked(workerA, teamB)).toBeNull();
    await db.worker.update({ where: { id: workerA2 }, data: { retiredAt: new Date() } });
    expect(await stampChannelCheck(db, workerA2, teamA)).toBe(false);
    await db.channel.update({ where: { id: teamA }, data: { deletedAt: new Date() } });
    expect(await stampChannelCheck(db, workerA, teamA)).toBe(false);
  });
});

describe('stampTeamChannelChecks (the inbox read) is scoped to the worker\'s own App team channel', () => {
  it('stamps the own App team channel only: not another channel of the App, not another App\'s team channel', async () => {
    expect(await stampTeamChannelChecks(db, workerA)).toBe(1);
    expect(await checked(workerA, teamA)).toBeInstanceOf(Date);
    expect(await checked(workerA, otherA)).toBeNull(); // a non-team channel of the same App
    expect(await checked(workerA, teamB)).toBeNull(); // another App's team channel
    expect(await db.channelReadState.count({ where: { workerId: workerA } })).toBe(1);
  });

  it('stamps nothing for another worker of the App, for a retired worker, or when the App has no team channel', async () => {
    await stampTeamChannelChecks(db, workerA);
    expect(await checked(workerA2, teamA)).toBeNull();
    await db.worker.update({ where: { id: workerA2 }, data: { retiredAt: new Date() } });
    expect(await stampTeamChannelChecks(db, workerA2)).toBe(0);
    await db.channel.update({ where: { id: teamB }, data: { deletedAt: new Date() } });
    expect(await stampTeamChannelChecks(db, workerB)).toBe(0);
    expect(await checked(workerB, teamB)).toBeNull();
  });
});
