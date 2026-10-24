import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1981 — cor:agt:070:07: every refused call of a host key is recorded, `issueHostOperation` included. Only whoever
 * manages the App (and a worker's holder, or the worker it reports to) issues, so every App key is refused FORBIDDEN;
 * a key that holds or EVER held `host:operate` records that refusal as action 'issue', apart from the call. A key
 * never granted the scope records nothing (no host to record under), and the gate never reads the record.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const F = resolvers as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string };
let manager: { id: string };
let kit: { id: string };
let orca1: { id: string };
let plainKey: { id: string };

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const issue = (c: Context) =>
  M.issueHostOperation({}, {
    input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worktree.create', args: { repo: 'hadron-server', baseBranch: 'main', branchName: 'kit/1981', label: 'kit-1981' } },
  }, c);
const uses = () => db.hostKeyUse.findMany({ where: { action: 'issue' }, orderBy: { usedAt: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Issue1981', urn: `issue1981-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 71_000_000 + n, githubUsername: `i81-m-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true } });
  orca1 = await mkKey('orca1');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost({}, {
    input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] },
  }, keyCtx(orca1));
});

describe('#1981: a host key\'s refused issueHostOperation is recorded', () => {
  it('a live host key is refused FORBIDDEN, and the refusal reads back through hostUses', async () => {
    expect(await code(issue(keyCtx(orca1)))).toBe('FORBIDDEN');
    expect((await uses()).map((u) => [u.appKeyId, u.appId, u.hostId, u.refusedCode, u.operationId])).toEqual([[orca1.id, app.id, 'orca1', 'FORBIDDEN', null]]);
    const read = await F.AppKey.hostUses({ id: orca1.id, appId: app.id }, {}, ctx(manager.id));
    expect(read.map((u: any) => [u.action, u.refusedCode]).sort()).toEqual([['issue', 'FORBIDDEN'], ['register', null]]);
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('a key that EVER held host:operate still records after the scope is revoked', async () => {
    await M.revokeAppKeyScope({}, { id: orca1.id, scope: 'host:operate' }, ctx(manager.id));
    expect(await code(issue(keyCtx(orca1)))).toBe('FORBIDDEN');
    expect((await uses()).map((u) => [u.hostId, u.refusedCode])).toEqual([['orca1', 'FORBIDDEN']]);
  });

  it('a key never granted host:operate is refused and records nothing', async () => {
    expect(await code(issue(keyCtx(plainKey)))).toBe('FORBIDDEN');
    expect(await uses()).toHaveLength(0);
  });

  it('control: whoever manages the App issues, and nothing is recorded; a person\'s refusal records nothing', async () => {
    const before = await db.hostKeyUse.count();
    expect(await issue(ctx(manager.id))).toMatchObject({ status: 'issued', hostId: 'orca1', workerId: kit.id });
    const outsider = await db.user.create({ data: { githubId: 72_000_000, githubUsername: 'i81-out', roles: ['READER'] }, select: { id: true } });
    expect(await code(issue(ctx(outsider.id)))).toBeDefined();
    expect(await db.hostKeyUse.count()).toBe(before);
  });
});
