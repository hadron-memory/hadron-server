/**
 * #4544 (Direction A, gate CHECKED by Xenophon; FIT by Vera, issuecomment-7034402954): the person who ISSUED a secret read client
 * may request the signature of that client's grant and read the request, whether or not they manage the App. Before, a writer
 * who is not a manager could issue (cor:sec:060:01) and was then refused the signing request as GRANT_NOT_FOUND, so the grant was
 * stranded.
 *
 * Pins:
 *   - the issuing writer (an App participant, not a manager) requests the signature, gets a ceremonyUrl, and reads the request;
 *   - everyone else keeps today's answer, byte for byte: a non-manager participant who did not issue, an outsider, the issuer's
 *     own worker session, a run, an App key (GRANT_NOT_FOUND) and an impersonated session (FORBIDDEN); an unknown grant answers
 *     exactly as another person's grant does;
 *   - the reach is keyed on the read client's issuer: a grant with no read client row, and a client another person issued, give
 *     the writer nothing; an issuer who has left the App loses it;
 *   - the manager arm is unchanged.
 */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';
import { deploymentSchema } from './deploymentSchema.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let direct: ApolloServer<Context>;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  const schema = deploymentSchema();
  direct = new ApolloServer<Context>({ typeDefs: schema.typeDefs, resolvers: schema.resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
  await direct.start();
});
afterAll(async () => { await direct?.stop(); vi.unstubAllEnvs(); });

const REQUEST = 'mutation($g:ID!){requestGrantSignature(grantRef:$g){id grantId state ceremonyUrl requestedBy{userId}}}';
const READ = 'query($id:ID!){grantSigningRequest(id:$id){id grantId state ceremonyUrl}}';

let ownerId: string; let writerId: string; let memberId: string; let outsiderId: string; let appId: string; let secretId: string;
let agentId: string; let workerId: string;
const ctxOf = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as unknown as Context);

async function gql(query: string, variables: Record<string, unknown>, ctx: Context): Promise<any> {
  const r = await direct.executeOperation({ query, variables }, { contextValue: ctx });
  if (r.body.kind !== 'single') throw new Error('incremental');
  return r.body.singleResult;
}
/** The wire refusal with the caller's own ref taken out, so two refusals of different refs compare byte for byte. */
const refusal = (r: any, ref: string) => {
  expect(r.errors, JSON.stringify(r.data)).toHaveLength(1);
  return JSON.parse(JSON.stringify(r.errors[0]).split(ref).join('<ref>'));
};
const issue = async (userId: string): Promise<string> => ((await resolvers.Mutation.issueSecretReadClient({}, {
  input: { secretRef: secretId, holderKind: 'USER', autoDelete: false, reason: 'hand-off' },
}, ctxOf(userId))) as { grantId: string }).grantId;
const requestCount = () => db.grantSigningRequest.count();

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  const user = async () => (await db.user.create({ data: { email: `${generateId()}@4544.test` } })).id;
  ownerId = await user(); writerId = await user(); memberId = await user(); outsiderId = await user();
  appId = (await db.app.create({ data: { name: 'RC', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:rc` } })).id;
  await db.appMember.create({ data: { appId, userId: writerId, role: 'reader' } });
  await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
  // The writer of the current (only) version: a participant who does not manage the App.
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'v1' }, ctxOf(writerId))).id;
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: `${generateId().toLowerCase()}.test` } });
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'W', slug: 'w', heldByUserId: writerId, heldAt: new Date() }, select: { id: true } })).id;
});

describe('#4544 the issuer of a read client finishes the hand-off', () => {
  it('the issuing writer (not a manager) requests the signature, gets the ceremony URL, and reads the request', async () => {
    const g = await issue(writerId);
    const made = await gql(REQUEST, { g }, ctxOf(writerId));
    expect(made.errors).toBeUndefined();
    expect(made.data.requestGrantSignature).toMatchObject({ grantId: g, state: 'OPEN', requestedBy: { userId: writerId } });
    expect(made.data.requestGrantSignature.ceremonyUrl).toMatch(/\/grant-signing\/[A-Za-z0-9_-]+$/);
    const id = made.data.requestGrantSignature.id;
    const read = await gql(READ, { id }, ctxOf(writerId));
    expect(read.errors).toBeUndefined();
    expect(read.data.grantSigningRequest).toEqual({ id, grantId: g, state: 'OPEN', ceremonyUrl: made.data.requestGrantSignature.ceremonyUrl });
  });

  it('the manager arm is unchanged: the owner requests and reads the writer\'s client too', async () => {
    const g = await issue(writerId);
    const made = await gql(REQUEST, { g }, ctxOf(ownerId));
    expect(made.errors).toBeUndefined();
    expect((await gql(READ, { id: made.data.requestGrantSignature.id }, ctxOf(ownerId))).data.grantSigningRequest.grantId).toBe(g);
  });
});

describe('#4544 everyone else keeps today\'s answer', () => {
  it('a non-manager participant who did not issue, and an outsider, get GRANT_NOT_FOUND exactly as for an unknown grant', async () => {
    const g = await issue(writerId);
    const unknown = generateId();
    for (const who of [memberId, outsiderId]) {
      const theirs = refusal(await gql(REQUEST, { g }, ctxOf(who)), g);
      expect(theirs.extensions.code).toBe('GRANT_NOT_FOUND');
      expect(theirs).toEqual(refusal(await gql(REQUEST, { g: unknown }, ctxOf(who)), unknown));
    }
    expect(await requestCount()).toBe(0);
    // ...and cannot read a request the issuer opened (null, as for an unknown id).
    const id = (await gql(REQUEST, { g }, ctxOf(writerId))).data.requestGrantSignature.id;
    for (const who of [memberId, outsiderId]) {
      const r = await gql(READ, { id }, ctxOf(who));
      expect(r).toEqual(await gql(READ, { id: 'AAAAAAAAAAAAAAAAAAAAAA' }, ctxOf(who)));
      expect(r.data.grantSigningRequest).toBeNull();
    }
  });

  it('the issuer\'s own worker session, a run and an App key get GRANT_NOT_FOUND; an impersonated session FORBIDDEN, as today', async () => {
    const g = await issue(writerId);
    const asWorker = (q: string, v: Record<string, unknown>) => runAsActor({ workerId, agentId, userId: writerId }, () => gql(q, v, ctxOf(writerId)));
    const run = ctxOf(writerId, { appId, clientId: `${RUN_CLIENT_PREFIX}${generateId()}` } as Partial<Context>);
    const key = { db, appId, appKeyId: generateId(), roles: [] } as unknown as Context;
    expect(refusal(await asWorker(REQUEST, { g }), g).extensions.code).toBe('GRANT_NOT_FOUND');
    expect(refusal(await gql(REQUEST, { g }, run), g).extensions.code).toBe('GRANT_NOT_FOUND');
    expect(refusal(await gql(REQUEST, { g }, key), g).extensions.code).toBe('GRANT_NOT_FOUND');
    const imp = ctxOf(writerId, { impersonation: { sessionId: generateId(), actorUserId: ownerId, orgId: generateId(), expiresAt: new Date(Date.now() + 60_000) } } as Partial<Context>);
    expect(refusal(await gql(REQUEST, { g }, imp), g).extensions.code).toBe('FORBIDDEN');
    expect(await requestCount()).toBe(0);
  });

  it('a grant with no read client row, and a client another person issued, give the writer nothing', async () => {
    const bare = await issue(writerId);
    await db.secretReadClient.deleteMany({ where: { grantId: bare } });
    expect(refusal(await gql(REQUEST, { g: bare }, ctxOf(writerId)), bare).extensions.code).toBe('GRANT_NOT_FOUND');
    const ownersClient = await issue(ownerId);
    expect(refusal(await gql(REQUEST, { g: ownersClient }, ctxOf(writerId)), ownersClient).extensions.code).toBe('GRANT_NOT_FOUND');
    expect(await requestCount()).toBe(0);
  });

  it('an issuer who has left the App loses the reach', async () => {
    const g = await issue(writerId);
    await db.appMember.delete({ where: { appId_userId: { appId, userId: writerId } } });
    expect(refusal(await gql(REQUEST, { g }, ctxOf(writerId)), g).extensions.code).toBe('GRANT_NOT_FOUND');
    expect(await requestCount()).toBe(0);
  });
});
