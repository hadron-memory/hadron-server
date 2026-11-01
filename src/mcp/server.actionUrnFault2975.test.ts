/**
 * #2975 — `resolveActionEntryRef` (the action arm behind `hadron_get_node` and
 * `hadron_run_action`) must not turn an operational fault into "not found"
 * (cor:api:260:01). Its two catches — the agent lookup and the register-entry
 * lookup — swallowed a database fault as the uniform `Node "<urn>" not found.`
 * These pins fault each lookup and require the generic internal-fault envelope
 * (`isError` + `structuredContent.error {code, requestId}`). The refusal side
 * stays byte-identical, and unknown vs not-yours stay indistinguishable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { normalizeUrnForLookup, parseUrnInput } from '../lib/urn.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: { error?: Record<string, unknown> } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = 'task.fault.2975';
const BODY = 'ENTRY-BODY-2975';

let org: { id: string; urn: string };
let owner: { id: string };
let outsider: { id: string };
let agent: { id: string; urn: string };

const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });
const gqlCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const actionUrn = (agentUrn: string, code = CODE) => `hrn:action:${agentUrn}:${code}`;
const notFound = (urn: string) => `Node "${urn}" not found.`;
const getNode = async (as: string, urn: string) =>
  (await createTestableMcpServer(auth(as)).callTool('hadron_get_node', { urn })) as ToolResult;
const runAction = async (as: string, urn: string) =>
  (await createTestableMcpServer(auth(as)).callTool('hadron_run_action', { urn })) as ToolResult;

/** Reject the FIRST matching call with a plain Error (a fault whatever its text, cor:api:260:01); pass the rest through. */
function faultOnce(model: string, method: string, match: (args: any) => boolean) {
  const delegate = (db as any)[model];
  const real = delegate[method].bind(delegate) as (a: unknown) => Promise<unknown>;
  const state = { fired: false };
  vi.spyOn(delegate, method).mockImplementation(((a: any) => {
    if (!state.fired && match(a)) {
      state.fired = true;
      return Promise.reject(new Error('db down 2975 private-detail'));
    }
    return real(a);
  }) as any);
  return state;
}

/** First catch: resolveAgentRef's primary lookup of the action URN's agent. */
const faultAgentLookup = () => faultOnce('agent', 'findFirst', (a) => typeof a?.where?.urn === 'string');
/** Second catch: resolveNodeRefForAuth -> resolveNodeRef's memory-prefix lookup for the register entry. */
const faultEntryLookup = () => faultOnce('memory', 'findFirst', (a) => Array.isArray(a?.where?.urn?.in));

function expectFaultEnvelope(r: ToolResult, urn: string) {
  expect(r.isError).toBe(true);
  expect(r.content[0]!.text).not.toBe(notFound(urn));
  expect(r.content[0]!.text).not.toContain(BODY);
  expect(r.structuredContent?.error?.code).toBe('INTERNAL_SERVER_ERROR');
  expect(r.structuredContent?.error?.requestId).toMatch(UUID);
  expect(JSON.stringify(r)).not.toContain('private-detail');
}

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase().slice(-8);
  org = await db.organization.create({ data: { id: generateId(), name: 'fault org', urn: `mcpfault2975-${s}` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other org', urn: `mcpfault2975-other-${s}` } });
  owner = await db.user.create({ data: { id: generateId(), handle: `mf2975-owner-${s}`, githubUsername: `mf2975-owner-${s}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), handle: `mf2975-out-${s}`, githubUsername: `mf2975-out-${s}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });
  const created = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Fault Agent' }, gqlCtx(owner.id));
  const row = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  agent = { id: row.id, urn: row.urn };
  await db.node.create({
    data: {
      id: generateId(), memoryId: row.systemMemoryId as string, loc: `register:${CODE}`, name: CODE, content: BODY,
      data: { registerEntry: { code: CODE, taskLoc: 'tasks:fault' } },
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('#2975 hadron_get_node by action URN: an operational fault is a fault, not "not found"', () => {
  it('control: the owner reads the entry with no fault', async () => {
    const r = await getNode(owner.id, actionUrn(agent.urn));
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain(BODY);
  });

  it('first catch: a DB fault in the agent lookup surfaces the generic envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = faultAgentLookup();
    const urn = actionUrn(agent.urn);
    const r = await getNode(owner.id, urn);
    expect(probe.fired, 'the fault was injected').toBe(true);
    expectFaultEnvelope(r, urn);
  });

  it('second catch: a DB fault in the register-entry lookup surfaces the generic envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = faultEntryLookup();
    const urn = actionUrn(agent.urn);
    const r = await getNode(owner.id, urn);
    expect(probe.fired, 'the fault was injected').toBe(true);
    expectFaultEnvelope(r, urn);
  });

  it('hadron_run_action shares the helper: a DB fault in the agent lookup is a fault there too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = faultAgentLookup();
    const urn = actionUrn(agent.urn);
    const r = await runAction(owner.id, urn);
    expect(probe.fired, 'the fault was injected').toBe(true);
    expectFaultEnvelope(r, urn);
  });
});

describe('#2975 hadron_get_node by action URN: refusals stay byte-identical', () => {
  it('unknown agent, unknown code and malformed leaves all answer the uniform not-found', async () => {
    for (const urn of [
      actionUrn(`${org.urn}:no-such-agent`),
      actionUrn(agent.urn, 'task.no.such.code'),
      actionUrn(agent.urn, 'BAD CODE!'),
      `hrn:action:${agent.urn}`,
    ]) {
      const r = await getNode(owner.id, urn);
      expect(r.isError, urn).toBe(true);
      expect(r.content[0]!.text, urn).toBe(notFound(urn));
      expect(r.structuredContent, urn).toBeUndefined();
    }
  });

  // Gate ruling (a) on #2975 (Xanthos, team chat #63349): an ambiguous AGENT
  // alias keeps today's uniform not-found here; only faults change.
  it('an ambiguous legacy agent address stays the uniform not-found', async () => {
    const created2 = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Fault Agent Two' }, gqlCtx(owner.id));
    const old = `hrn:agent:${org.urn}:old-agent`;
    await db.agent.updateMany({
      where: { id: { in: [agent.id, created2.id] } },
      data: { legacyUrn: normalizeUrnForLookup(parseUrnInput(old).value) },
    });
    const urn = actionUrn(`${org.urn}:old-agent`);
    const r = await getNode(owner.id, urn);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(notFound(urn));
    expect(r.structuredContent).toBeUndefined();
  });

  it('oracle: for an outsider, not-yours and unknown differ only by the echoed URN', async () => {
    const mineUrn = actionUrn(agent.urn);
    const unknownUrn = actionUrn(`${org.urn}:no-such-agent`);
    const mine = await getNode(outsider.id, mineUrn);
    const unknown = await getNode(outsider.id, unknownUrn);
    expect(JSON.stringify(mine).split(mineUrn).join('<URN>')).toBe(JSON.stringify(unknown).split(unknownUrn).join('<URN>'));
    expect(mine.content[0]!.text).toBe(notFound(mineUrn));
  });
});
