/**
 * #4525 — amendQuestion with a survivor assignee when the stored deciders hold a merged-away id.
 * askQuestion stores deciders as survivors AT ASK TIME; a user merge afterwards can leave a stored decider that is
 * merged away. Naming that decider's survivor as the assignee must be accepted (the survivor IS the decider, #1715),
 * while a user who is not a decider stays refused, and later writes to the question keep working.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let survivor: { id: string };
let stranger: { id: string };
let chainMid: { id: string };
let chainEnd: { id: string };
let memory: { id: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; }
};
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });

async function askThenMerge(chain = false) {
  const log = await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [holger.id] }, as());
  const d = await M.askQuestion(null, { logRef: log.row.id, input: {
    title: 'Ship the codec?', yesno: true, recommendation: { key: 'yes', reason: 'ready' },
  } }, as(writer.id));
  // the merge AFTER the ask: the stored decider id is now merged away
  if (chain) {
    // two-step chain: holger -> chainMid -> chainEnd (survivorOf must follow both hops)
    await db.userMerge.create({ data: { sourceUserId: holger.id, targetUserId: chainMid.id } });
    await db.userMerge.create({ data: { sourceUserId: chainMid.id, targetUserId: chainEnd.id } });
  } else {
    await db.userMerge.create({ data: { sourceUserId: holger.id, targetUserId: survivor.id } });
  }
  return d.row.id as string;
}
const amend = async (id: string, input: Record<string, unknown>) =>
  M.amendQuestion(null, { ref: id, input, expectedRevision: (await rowOf(id)).revSeq, reason: 'reassign' }, as(writer.id));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Merged Org', urn: 'merged.example' } });
  const mk = (n: number, h: string) => db.user.create({ data: { githubId: 452500 + n, githubUsername: h, handle: h, roles: [] } });
  admin = await mk(1, 'qm-admin'); writer = await mk(2, 'qm-writer'); holger = await mk(3, 'qm-holger');
  survivor = await mk(4, 'qm-survivor'); stranger = await mk(5, 'qm-stranger');
  chainMid = await mk(6, 'qm-chain-mid'); chainEnd = await mk(7, 'qm-chain-end');
  await db.orgMember.createMany({ data: [admin, writer, holger, survivor, stranger, chainMid, chainEnd].map((u, i) => ({
    organizationId: org.id, userId: u.id, role: i === 0 ? 'ADMIN' as const : 'CONTRIBUTOR' as const,
  })) });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'team-shared' }, as());
});

describe('amendQuestion after a merge of a stored decider (#4525)', () => {
  it('accepts the survivor of a merged-away stored decider as the assignee', async () => {
    const id = await askThenMerge();
    await amend(id, { assignee: survivor.id });
    expect((await rowOf(id).then((r) => r.data as any)).assignee).toBe(survivor.id);
  });

  it('still refuses an unmerged stranger while a decider is merged', async () => {
    const id = await askThenMerge();
    expect(await codeOf(amend(id, { assignee: stranger.id }))).toBe('QUESTION_ASSIGNEE_NOT_DECIDER');
    expect((await rowOf(id).then((r) => r.data as any)).assignee ?? null).toBeNull();
  });

  it('refuses the survivor of a merge between two NON-deciders', async () => {
    const id = await askThenMerge();
    await db.userMerge.create({ data: { sourceUserId: stranger.id, targetUserId: chainMid.id } });
    expect(await codeOf(amend(id, { assignee: chainMid.id }))).toBe('QUESTION_ASSIGNEE_NOT_DECIDER');
    expect((await rowOf(id).then((r) => r.data as any)).assignee ?? null).toBeNull();
  });

  it('accepts the end of a two-step merge chain (decider -> A -> B, assignee B)', async () => {
    const id = await askThenMerge(true);
    await amend(id, { assignee: chainEnd.id });
    expect((await rowOf(id).then((r) => r.data as any)).assignee).toBe(chainEnd.id);
  });

  it('keeps later writes working once the survivor is the assignee (the check is merge-aware on every write)', async () => {
    const id = await askThenMerge();
    await amend(id, { assignee: survivor.id });
    await amend(id, { title: 'Ship the codec this week?' });
    const mid = await rowOf(id).then((r) => r.data as any);
    expect(mid.title).toBe('Ship the codec this week?');
    expect(mid.assignee).toBe(survivor.id);
    expect(await codeOf(M.withdrawQuestion(null, { ref: id, reason: 'moot', expectedRevision: (await rowOf(id)).revSeq }, as(writer.id)))).toBe('NO_ERROR');
    const end = await rowOf(id).then((r) => r.data as any);
    expect(end.status).toBe('withdrawn');
    expect(end.assignee).toBe(survivor.id);
    expect(end.title).toBe('Ship the codec this week?');
  });
});
