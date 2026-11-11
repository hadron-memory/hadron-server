/**
 * #3907 — Query.accountUsageProjection answers the App's own key like it answers a participant (cor:agt:140:05, S8).
 * The key arm reads under the App's shared authority anchors in ONE transaction; with Prisma's default 5 s interactive cap the
 * probe over a large usage memory (QA: 121k rows per selector, a move reads two) ended in INTERNAL_SERVER_ERROR (P2028) while the
 * participant arm, which has no transaction, answered. Slowness is injected per history read, so no 121k-row fixture is needed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db as baseDb } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const Q = resolvers.Query as any;
const MIN = 60_000;
/** Each history read costs this; a move makes two selector reads, so ~6 s in total, past the 5 s default cap and far below 30 s. */
const READ_MS = 3_000;
const slowDb = baseDb.$extends({
  query: { node: { async findMany({ args, query }) { await new Promise((r) => setTimeout(r, READ_MS)); return query(args); } } },
}) as unknown as Context['db'];

afterAll(async () => { await cleanDb(baseDb); });

let appId: string;
let memberId: string;
let keyId: string;

beforeEach(async () => {
  await cleanDb(baseDb);
  const n = Math.floor(Math.random() * 1_000_000_000);
  const org = await baseDb.organization.create({ data: { id: generateId(), name: 'KT', urn: `kt-${n}.example` } });
  const member = await baseDb.user.create({ data: { id: generateId(), githubId: 900_000 + n, githubUsername: `kt-m-${n}`, roles: ['READER'] } });
  memberId = member.id;
  const agentId = (await baseDb.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } })).id;
  appId = (await baseDb.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } })).id;
  await baseDb.appAgent.create({ data: { appId, agentId } });
  await baseDb.appMember.create({ data: { appId, userId: member.id, role: 'member' } });
  const memoryId = (await baseDb.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId, sharedMemoryOfAgentId: agentId } })).id;
  keyId = (await baseDb.appKey.create({ data: { id: generateId(), appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } })).id;
  void memoryId;
});

describe('the App-key arm of accountUsageProjection survives a slow read (#3907)', () => {
  it('answers the key like a participant when a two-selector move outlasts the default 5 s transaction cap', async () => {
    const vars = { appRef: '', account: 'acct-a', whatIf: { moveWorker: { worker: 'Anne', toAccount: 'acct-b' } } };
    const keyCtx: Context = { db: slowDb, appId, appKeyId: keyId, roles: [] };
    const memberCtx: Context = { db: slowDb, userId: memberId, roles: ['READER'] };
    const asMember = await Q.accountUsageProjection({}, { ...vars, appRef: appId }, memberCtx).catch((e: unknown) => e);
    const asKey = await Q.accountUsageProjection({}, { ...vars, appRef: appId }, keyCtx).catch((e: unknown) => e);
    // The participant arm has no transaction: whatever it answers (here the unconfigured worker is refused), the key answers the same.
    expect(String((asKey as Error)?.message ?? JSON.stringify(asKey))).toBe(String((asMember as Error)?.message ?? JSON.stringify(asMember)));
    expect(String((asKey as Error)?.message ?? '')).not.toMatch(/Transaction|P2028|Internal/i);
  }, 60_000);
});
