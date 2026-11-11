/**
 * #3907 — Query.accountUsageProjection answers the App's own key like it answers a participant (cor:agt:140:03, :05).
 * The key arm reads under the App's shared authority anchors in ONE transaction; with Prisma's default 5 s interactive cap the
 * probe over a large usage memory (QA: 121k rows per selector, a move reads two) ended in INTERNAL_SERVER_ERROR (P2028) while the
 * participant arm, which has no transaction, answered. Slowness is injected per history read, so no 121k-row fixture is needed.
 * The move is configured to SUCCEED (a listed worker, a target with history), so both delayed reads run and a projection is asserted.
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
/** Each history read costs this; a move makes two selector reads, so ~6 s in total: past the 5 s default cap, far below 30 s. */
const READ_MS = 3_000;
let reads = 0;
const slowDb = baseDb.$extends({
  query: { node: { async findMany({ args, query }) { reads += 1; await new Promise((r) => setTimeout(r, READ_MS)); return query(args); } } },
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
  // acct-a lists Anne (the worker to move), acct-b is the target; three valid snapshots each, so the move reaches its answer.
  const snap = (label: string, i: number) => ({
    id: generateId(), memoryId, name: `u-${label}-${i}`, loc: `account-usage:${generateId()}`, nodeType: 'info', objectType: 'account-usage',
    properties: {
      schemaVersion: 1, label, family: 'claude', host: 'h1', observedAt: new Date(Date.now() - (10 - i) * MIN).toISOString(),
      sevenDayPct: 10 + i, sevenDayResetsAt: new Date(Date.now() + 40 * 3_600_000).toISOString(),
      workers: label === 'acct-a' ? ['Anne'] : ['Bea'], workersConfigured: true,
    },
  });
  await baseDb.node.createMany({ data: [0, 1, 2].flatMap((i) => [snap('acct-a', i), snap('acct-b', i)]) });
});

describe('the App-key arm of accountUsageProjection survives a slow read (#3907)', () => {
  it('answers the key like a participant when a two-selector move outlasts the default 5 s transaction cap', async () => {
    const vars = { account: 'acct-a', whatIf: { moveWorker: { worker: 'Anne', toAccount: 'acct-b' } } };
    const keyCtx: Context = { db: slowDb, appId, appKeyId: keyId, roles: [] };
    const memberCtx: Context = { db: slowDb, userId: memberId, roles: ['READER'] };
    reads = 0;
    const asMember = await Q.accountUsageProjection({}, { ...vars, appRef: appId }, memberCtx);
    // the fixture is real: both selector reads ran (~6 s, past the 5 s default) and the move produced its answer
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(asMember.whatIf).not.toBeNull();
    reads = 0;
    const asKey = await Q.accountUsageProjection({}, { ...vars, appRef: appId }, keyCtx);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(asKey.whatIf).not.toBeNull();
    expect({ ...asKey, asOf: null }).toEqual({ ...asMember, asOf: null });
  }, 60_000);
});
