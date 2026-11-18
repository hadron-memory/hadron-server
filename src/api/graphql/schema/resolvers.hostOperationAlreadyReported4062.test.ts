/**
 * #4062 — `reportHostOperation`'s HOST_OPERATION_ALREADY_REPORTED refusal carries the outcome already recorded in
 * `extensions.status`, spelled as the `HostOperationStatus` enum (`SUCCEEDED` / `FAILED`, the same spelling as the
 * `outcome` the host sends; Vera's FIT on #4062, binding per the CHECKED gate). The hadron-cli host poller
 * (cli#1817 `finalRecorded`) reads the recorded outcome off the message today, so the message template is pinned
 * here too, exactly as it reads now, until the CLI moves to the extension.
 *
 * Governing law: hrn:node:hadronmemory.com:specs:cor:api:260:01 (a typed refusal carries its own code and message),
 * hrn:node:hadronmemory.com:specs:cor:agt:070:02 / :03 (same outcome again answers as-is; a different one is refused).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { sweepUnreportedHostOperations } from '../../../lib/hostOperations/settle.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let app: { id: string };
let manager: { id: string };
let kit: { id: string };
let orca1: { id: string };

const keyCtx = (k: { id: string }): Context =>
  ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const issue = () =>
  M.issueHostOperation({}, {
    input: {
      appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worktree.create',
      args: { repo: 'hadron-server', baseBranch: 'main', branchName: 'kit/4062-x', label: 'kit-4062' },
    },
  }, ctx(manager.id));
const collect = () => M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1));
const report = (input: Record<string, unknown>) => M.reportHostOperation({}, { input: { appRef: app.id, ...input } }, keyCtx(orca1));
const SUCCESS = { outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-4062' };
const FAILURE = { outcome: 'FAILED', failureReason: 'branch kit/4062-x already exists' };

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return e as GraphQLError;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Hosts', urn: `hostops4062-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 406_000_000 + n, githubUsername: `ho4062-manager-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true } });
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost({}, {
    input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 60, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] },
  }, keyCtx(orca1));
});

describe('#4062: HOST_OPERATION_ALREADY_REPORTED names the recorded outcome in extensions.status', () => {
  it('recorded SUCCEEDED, then FAILED reported: status SUCCEEDED, the id, and today\'s message', async () => {
    const op = await issue();
    await collect();
    await report({ id: op.id, ...SUCCESS });
    const e = await refusal(report({ id: op.id, ...FAILURE }));
    expect(e.extensions).toEqual({ code: 'HOST_OPERATION_ALREADY_REPORTED', id: op.id, status: 'SUCCEEDED' });
    // The interim contract the CLI's finalRecorded regexp reads (cli#1817): frozen as it reads now, lowercase.
    expect(e.message).toBe('This operation was already reported succeeded.');
  });

  it('recorded FAILED, then SUCCEEDED reported: status FAILED and today\'s message', async () => {
    const op = await issue();
    await collect();
    await report({ id: op.id, ...FAILURE });
    const e = await refusal(report({ id: op.id, ...SUCCESS }));
    expect(e.extensions).toEqual({ code: 'HOST_OPERATION_ALREADY_REPORTED', id: op.id, status: 'FAILED' });
    expect(e.message).toBe('This operation was already reported failed.');
  });

  it('an operation the timeout sweep failed reports FAILED the same way', async () => {
    const op = await issue();
    await collect();
    const collectedAt = (await db.hostOperation.findUniqueOrThrow({ where: { id: op.id } })).collectedAt!;
    expect(await sweepUnreportedHostOperations(db, new Date(collectedAt.getTime() + 24 * 60 * 60_000))).toBe(1);
    const e = await refusal(report({ id: op.id, ...SUCCESS }));
    expect(e.extensions).toMatchObject({ code: 'HOST_OPERATION_ALREADY_REPORTED', status: 'FAILED' });
  });

  it('on the wire: the formatted GraphQL error keeps code, id and status', async () => {
    const op = await issue();
    await collect();
    await report({ id: op.id, ...SUCCESS });
    const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
    const response = await server.executeOperation({
      query: 'mutation($input: ReportHostOperationInput!) { reportHostOperation(input: $input) { id status } }',
      variables: { input: { appRef: app.id, id: op.id, ...FAILURE } },
    }, { contextValue: keyCtx(orca1) });
    if (response.body.kind !== 'single') throw new Error('incremental response');
    const errors = response.body.singleResult.errors ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('This operation was already reported succeeded.');
    expect(errors[0]!.extensions).toEqual({ code: 'HOST_OPERATION_ALREADY_REPORTED', id: op.id, status: 'SUCCEEDED' });
  });

  it('the same outcome again is still answered, not refused (cor:agt:070:03 unchanged)', async () => {
    const op = await issue();
    await collect();
    const done = await report({ id: op.id, ...SUCCESS });
    const again = await report({ id: op.id, ...SUCCESS });
    expect(again).toMatchObject({ id: op.id, status: 'succeeded' });
    expect(again.finishedAt).toEqual(done.finishedAt);
  });
});
