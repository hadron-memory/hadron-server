/**
 * #3884 — Query.accountUsageAccounts answers the App's own key like it answers a participant (cor:agt:140:05, S8).
 * The key arm reads under the App's shared authority anchors in ONE transaction; with Prisma's default 5 s interactive cap a
 * large usage memory (200 candidate identities, one history read each) made it end in INTERNAL_SERVER_ERROR while the participant
 * arm, which has no transaction, answered. The read is made slow here the way a big table makes it slow (every history read
 * costs wall time), so the pin needs no 100k-row fixture.
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
/** 200 examined candidates x this = 6 s of read time, past the 5 s default cap and far below any sane pinned one. */
const READ_MS = 30;
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
  // 202 in-horizon identities, every snapshot invalid (observed 30 minutes in the future): validation walks all 200 examined.
  const rows = Array.from({ length: 202 }, (_, i) => {
    const id = generateId();
    return {
      id, memoryId, name: `u-${id.slice(-6)}`, loc: `account-usage:${id}`, nodeType: 'info', objectType: 'account-usage',
      properties: {
        schemaVersion: 1, label: `acct-${i}`, family: 'claude', host: 'h1', observedAt: new Date(Date.now() + 30 * MIN).toISOString(),
        sevenDayPct: 40, sevenDayResetsAt: new Date(Date.now() + 40 * 3_600_000).toISOString(), workers: ['Anne'], workersConfigured: true,
      },
    };
  });
  await baseDb.node.createMany({ data: rows });
});

describe('the App-key arm of accountUsageAccounts survives a slow read (#3884)', () => {
  it('answers the key exactly as it answers a participant when the validation reads outlast the default 5 s transaction cap', async () => {
    const keyCtx: Context = { db: slowDb, appId, appKeyId: keyId, roles: [] };
    const memberCtx: Context = { db: slowDb, userId: memberId, roles: ['READER'] };
    const asMember = await Q.accountUsageAccounts({}, { appRef: appId }, memberCtx);
    // the fixture is real: the participant arm walks the whole bound and reports the search cut
    expect(asMember).toMatchObject({ accounts: [], complete: false });
    const asKey = await Q.accountUsageAccounts({}, { appRef: appId }, keyCtx);
    expect(asKey).toMatchObject({ accounts: [], complete: false });
  }, 60_000);
});
