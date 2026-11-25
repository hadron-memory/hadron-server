/**
 * #5110 — agentRevisions refuses a live Agent with no system memory with a typed code (cor:dmo:050:23).
 *
 * A bare Error is masked on the wire as INTERNAL_SERVER_ERROR, so a manager could not tell this state from a server fault.
 * The code is the one repairAgentSystemMemory already uses for the same state. Run through the executor with the real
 * formatError: a direct resolver call never sees the mask.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers: resolvers as never, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });

let manager: { id: string };
let reader: { id: string };
let contributor: { id: string };
let owner: { id: string };
let outsider: { id: string };
let agent: { id: string; systemMemoryId: string | null };

/** The one error a list call answers on the wire. */
async function wireError(userId: string | undefined, ref = agent.id) {
  const r = await server.executeOperation(
    { query: 'query($a: ID!){ agentRevisions(agentRef: $a){ highestSlotUsed } }', variables: { a: ref } },
    { contextValue: { db, roles: userId ? ['READER'] : [], userId } as Context },
  );
  if (r.body.kind !== 'single') throw new Error('expected a single result');
  const { errors, data } = r.body.singleResult;
  expect(data ?? null).toBeNull(); // agentRevisions is non-null, so a refusal nulls the whole data (#5130 BLIND F8)
  expect(errors).toHaveLength(1);
  return { message: errors![0].message, extensions: errors![0].extensions };
}
const dropSystemMemory = (over: { deletedAt?: Date } = {}) => db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: null, ...over } });

beforeEach(async () => {
  await cleanDb(db);
  const user = (n: number, name: string) => db.user.create({ data: { githubId: n, githubUsername: name, roles: ['READER'] } });
  manager = await user(85110, 'rev5110-mgr');
  reader = await user(85111, 'rev5110-reader');
  outsider = await user(85112, 'rev5110-out');
  contributor = await user(85113, 'rev5110-contrib');
  owner = await user(85114, 'rev5110-owner');
  const org = await db.organization.create({ data: { id: generateId(), name: 'rev5110', urn: 'rev5110' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  agent = await resolvers.Mutation.createAgent({}, { orgRef: org.id, name: 'agent-5110', visibility: 'ORGANIZATION' }, { db, roles: ['READER'], userId: manager.id } as Context);
  expect(agent.systemMemoryId).toBeTruthy();
});

describe('#5110: no system memory is a typed refusal on the wire', () => {
  it('answers the Agent\'s manager AGENT_HAS_NO_SYSTEM_MEMORY with the message, not the masked server fault', async () => {
    await dropSystemMemory();
    const e = await wireError(manager.id);
    expect(e.extensions).toEqual({ code: 'AGENT_HAS_NO_SYSTEM_MEMORY', agentId: agent.id });
    expect(e.message).toBe('Agent has no system memory');
  });

  it('the agentRevisions SDL lists the code among its error codes', () => {
    const doc = buildSchema(typeDefs as unknown as string, { assumeValid: true }).getQueryType()!.getFields().agentRevisions.description ?? '';
    expect(doc).toContain('Error codes (extensions.code):');
    const codes = doc.slice(doc.indexOf('Error codes (extensions.code):'));
    for (const code of ['AGENT_HAS_NO_SYSTEM_MEMORY', 'AGENT_NOT_FOUND', 'FORBIDDEN']) expect(codes).toContain(code);
  });
});

describe('#5110: the code is reached only past the gates (cor:dmo:050:23 S5, S6)', () => {
  it('a reader who does not manage the Agent is refused FORBIDDEN, the same as when it has its system memory', async () => {
    const before = await wireError(reader.id);
    expect(before.extensions?.code).toBe('FORBIDDEN');
    await dropSystemMemory();
    expect(await wireError(reader.id)).toEqual(before);
  });

  // #5130 BLIND F3: the role just below the gate, so lowering ADMIN to CONTRIBUTOR is caught.
  it('a CONTRIBUTOR, the role just below the gate, is refused FORBIDDEN, the same as when it has its system memory', async () => {
    const before = await wireError(contributor.id);
    expect(before.extensions?.code).toBe('FORBIDDEN');
    await dropSystemMemory();
    expect(await wireError(contributor.id)).toEqual(before);
  });

  it('an org OWNER, above the gate, gets the new code', async () => {
    await dropSystemMemory();
    expect((await wireError(owner.id)).extensions?.code).toBe('AGENT_HAS_NO_SYSTEM_MEMORY');
  });

  it('an outsider gets the not-found answer, the same as when it has its system memory', async () => {
    const before = await wireError(outsider.id);
    expect(before.extensions?.code).toBe('AGENT_NOT_FOUND');
    await dropSystemMemory();
    expect(await wireError(outsider.id)).toEqual(before);
  });

  it('a caller with no principal gets the not-found answer, the same as when it has its system memory', async () => {
    const before = await wireError(undefined);
    expect(before.extensions?.code).toBe('AGENT_NOT_FOUND');
    await dropSystemMemory();
    expect(await wireError(undefined)).toEqual(before);
  });

  it('a deleted Agent with no system memory answers its manager as absent, never the new code', async () => {
    await dropSystemMemory({ deletedAt: new Date() });
    expect((await wireError(manager.id)).extensions?.code).toBe('AGENT_NOT_FOUND');
  });
});
