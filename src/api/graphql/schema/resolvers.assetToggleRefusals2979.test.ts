/**
 * #2979 — setAgentAssetUploadEnabled's refusals reach the wire with their own code.
 * `SetAssetEnabledError` is a plain Error carrying `code`; formatGraphQLError had no entry for it, so every refusal
 * answered INTERNAL_SERVER_ERROR + requestId and logged a fault (cor:api:260:01, the #1789 class).
 * Answers are read off the GraphQL wire. #1946's same-answer property is pinned alongside: an Agent the caller cannot
 * read and a ref that names nothing answer byte-identically.
 */
import { ApolloServer } from '@apollo/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const graphql = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

type Answer = { data: any; error: { message: string; extensions: Record<string, unknown> } | null };

async function toggle(userId: string, agentUrn: string, enabled = true): Promise<Answer> {
  const res = await graphql.executeOperation(
    {
      query: 'mutation($i: SetAgentAssetUploadEnabledInput!) { setAgentAssetUploadEnabled(input: $i) { id } }',
      variables: { i: { agentUrn, enabled } },
    },
    { contextValue: { db, userId, roles: ['READER'] } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}

let org: { id: string; urn: string };
let adminId: string;
let readerId: string;
let outsiderId: string;
let ownerId: string;
let agent: { id: string; urn: string };
let userAgent: { id: string; urn: string };

const user = async (handle: string) =>
  (await db.user.create({ data: { id: generateId(), name: handle, handle: `${handle}-${generateId().slice(-6)}`, roles: ['READER'] } })).id;
const ref = (a: { urn: string }) => `hrn:agent:${a.urn}`;
const mask = (a: Answer, r: string) => JSON.parse(JSON.stringify(a).split(r).join('<ref>'));

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().slice(-8);
  org = await db.organization.create({ data: { name: 'Toggle', urn: `toggle-${n}.example` }, select: { id: true, urn: true } });
  [adminId, readerId, outsiderId, ownerId] = await Promise.all(['admin', 'reader', 'outsider', 'owner'].map(user));
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: readerId, role: 'READER' } });
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'helper system', urn: `${org.urn}:helper-system` } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: 'helper', urn: `${org.urn}:helper`, visibility: 'ORGANIZATION', systemMemoryId: mem.id } });
  agent = { id: a.id, urn: a.urn };
  await db.app.create({ data: { organizationId: org.id, name: 'helper app', urn: a.urn } });
  const handle = `own-${n}`;
  await db.user.update({ where: { id: ownerId }, data: { handle } });
  const umem = await db.memory.create({ data: { class: 'system', name: 'own system', urn: `${handle}:own-system`, userId: null } as any }).catch(() => null);
  const ua = await db.agent.create({ data: { ownerUserId: ownerId, name: 'own', urn: `${handle}:own`, visibility: 'PERSONAL', ...(umem ? { systemMemoryId: umem.id } : {}) } as any });
  userAgent = { id: ua.id, urn: ua.urn };
});

describe('#2979 setAgentAssetUploadEnabled refusals are typed on the wire', () => {
  it('control: an org admin toggles the Agent\'s App', async () => {
    const a = await toggle(adminId, ref(agent));
    expect(a.error).toBeNull();
  });

  it('a non-admin who can read the Agent gets PERMISSION_DENIED, its own message, no requestId, no fault log', async () => {
    const fault = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await toggle(readerId, ref(agent));
    expect(a.error?.extensions.code).toBe('PERMISSION_DENIED');
    expect(a.error?.message).toBe('admin role required');
    expect(a.error?.extensions).not.toHaveProperty('requestId');
    expect(fault).not.toHaveBeenCalledWith('[graphql] internal_fault', expect.anything());
  });

  it('an Agent the caller cannot read and a ref naming nothing answer the same typed NOT_FOUND, with no id', async () => {
    const fault = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = `hrn:agent:${org.urn}:nobody`;
    const real = await toggle(outsiderId, ref(agent));
    const absent = await toggle(outsiderId, missing);
    expect(real.error?.extensions.code).toBe('NOT_FOUND');
    expect(real.error?.message).toBe('agent not found');
    expect(real.error?.extensions).not.toHaveProperty('requestId');
    expect(JSON.stringify(real)).not.toContain(agent.id);
    expect(mask(real, ref(agent))).toEqual(mask(absent, missing));
    expect(fault).not.toHaveBeenCalledWith('[graphql] internal_fault', expect.anything());
  });

  it('a user-owned Agent the caller can read answers its own NOT_FOUND refusal, typed', async () => {
    const a = await toggle(ownerId, ref(userAgent));
    expect(a.error?.extensions.code).toBe('NOT_FOUND');
    expect(a.error?.message).toMatch(/user-owned/);
    expect(a.error?.extensions).not.toHaveProperty('requestId');
  });

  it('an admin with no backing App gets the typed "app for agent not found"', async () => {
    await db.app.deleteMany({ where: { urn: agent.urn } });
    const a = await toggle(adminId, ref(agent));
    expect(a.error?.extensions.code).toBe('NOT_FOUND');
    expect(a.error?.message).toBe('app for agent not found');
    expect(a.error?.extensions).not.toHaveProperty('requestId');
  });

  // Atilla's P2 on #3144: the operation's own agent lookup used a catch-all, which once the class is a trusted
  // refusal would turn an outage into NOT_FOUND (no requestId, silenced in Sentry). Only an absent ref may.
  it.each([[1], [2]])('a database outage on lookup %i stays an INTERNAL_SERVER_ERROR, never a typed NOT_FOUND', async (failOn) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = db.agent.findFirst.bind(db.agent) as (...a: unknown[]) => Promise<unknown>;
    let n = 0;
    vi.spyOn(db.agent, 'findFirst').mockImplementation(((...a: unknown[]) =>
      ++n === failOn ? Promise.reject(new Error('connection lost')) : real(...a)) as never);
    const a = await toggle(adminId, ref(agent));
    expect(n).toBeGreaterThanOrEqual(failOn);
    expect(a.error?.extensions.code).toBe('INTERNAL_SERVER_ERROR');
    expect(a.error?.extensions).toHaveProperty('requestId');
  });
});
