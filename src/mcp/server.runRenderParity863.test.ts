/**
 * #863 (cor:api:060:05, render vs execute) — the MCP run tools render the prompt `runTask` executes.
 *
 * `hadron_run_action` and `hadron_run_task`'s render path used their own assembler (`renderRunNodeBundle`): a literal
 * `replaceAll` per argument, with every outgoing edge inlined. `runTask` and the GraphQL `renderRunNode` preview use
 * `assembleRunNodePrompt`: a Mustache compile (the memory's default data, an unsupplied variable renders empty) and
 * no flow-routing (`next*`) edge inlined (D-MN-4: rails, not references). So a preview through MCP showed a prompt
 * that was never run, with the next step's instructions in it.
 *
 * The pins compare the tool's text with the assembler `runTask` calls, byte for byte.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { assembleRunNodePrompt } from '../lib/runNodeRender.js';
import { compileTemplate } from '../lib/template.js';
import { setResolutionLimits } from '../lib/includes/resolutionBudget.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const NEXT_STEP = 'NEXT-STEP-INSTRUCTIONS-THAT-BELONG-TO-THE-FOLLOWING-HOP';
const REFERENCE = 'reference text the step depends on';

let ownerId: string;
let memId: string;
let memUrn: string;
let stepId: string;

const auth = (): AuthContext => ({ userId: ownerId, roles: ['ADMIN'], clientId: `user:${ownerId}` });
const nodeUrn = (loc: string): string => {
  const i = memUrn.indexOf(':');
  return `${memUrn.slice(0, i)}::${memUrn.slice(i + 1)}::${loc}`;
};
const mkNode = (loc: string, name: string, content: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: memId, loc, name, nodeType: 'info', content, tags: [], ...extra } as never });
const mkEdge = (source: { id: string; loc: string }, name: string, target: { id: string; loc: string }) =>
  db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: source.id, targetId: target.id, loc: deriveEdgeLoc(source.loc, name, target.loc), name } });

/** What `runTask` assembles for this node and these args (the function it calls, with the dependencies it passes). */
async function executed(id: string, args?: Record<string, string>): Promise<string> {
  const node = await db.node.findUniqueOrThrow({
    where: { id },
    include: { outgoingEdges: { where: { deletedAt: null, target: { deletedAt: null } }, include: { target: true } } },
  });
  return assembleRunNodePrompt({ ...node, loc: node.loc } as never, args, {
    memoryUrnOf: async (memoryId: string) => (await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } })).urn,
    includeTarget: () => true, // every target here is in the caller's own memory
    compileTemplate: (content: string, data: Record<string, string> | null, memoryId: string) => compileTemplate(content, data, memoryId, db, {}),
  });
}
const viaAction = (loc: string, args?: Record<string, string>) =>
  createTestableMcpServer(auth()).callToolText('hadron_run_action', { urn: nodeUrn(loc), ...(args ? { args } : {}) });
const viaTask = (loc: string, args?: Record<string, string>) =>
  createTestableMcpServer(auth()).callToolText('hadron_run_task', { urn: nodeUrn(loc), ...(args ? { args } : {}) });
const tools = [['hadron_run_action', viaAction], ['hadron_run_task (render path)', viaTask]] as const;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'render-parity', urn: `rp-${generateId()}` } });
  const owner = await db.user.create({ data: { githubId: 86301, githubUsername: `rp-owner-${generateId()}`, roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  ownerId = owner.id;
  const ctx: Context = { db, roles: ['ADMIN'], userId: owner.id };
  const created = (await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `Flow-${generateId()}` }, ctx)) as { id: string };
  const mem = await db.memory.findUniqueOrThrow({ where: { id: created.id }, select: { id: true, urn: true } });
  memId = mem.id;
  memUrn = mem.urn;

  // A step of a multi-node flow: a supplied variable, an unsupplied one, a value from the memory's default data node,
  // a routing edge to the next step and an ordinary reference.
  await mkNode('data', 'data', '', { data: { owner: 'Ada' } });
  const step = await mkNode('tasks:step-one', 'Step one', 'Review {{subject}} for {{owner}}.[{{missing}}]', { isRunnable: true });
  const next = await mkNode('tasks:step-two', 'Step two', NEXT_STEP, { isRunnable: true });
  const ref = await mkNode('docs:ref', 'Reference', REFERENCE);
  await mkEdge(step, 'next', next);
  await mkEdge(step, 'depends-on', ref);
  stepId = step.id;
});
afterEach(() => setResolutionLimits(null));

describe('#863: the MCP run tools return the prompt runTask executes', () => {
  it.each(tools)('%s: byte-identical to the execution assembler for a flow step', async (_name, call) => {
    const text = await call('tasks:step-one', { subject: 'the incident' });
    expect(text).toBe(await executed(stepId, { subject: 'the incident' }));
  });

  it.each(tools)('%s: what that means, spelled out', async (_name, call) => {
    const text = await call('tasks:step-one', { subject: 'the incident' });
    expect(text).toContain('Review the incident for Ada.[]'); // the memory default is used; an unsupplied variable renders empty
    expect(text).not.toContain('{{missing}}');
    expect(text).not.toContain(NEXT_STEP); // a routing edge is a rail, not a reference
    expect(text).toContain(REFERENCE); // an ordinary reference is still inlined
  });

  it.each(tools)('%s: with no args at all the same holds', async (_name, call) => {
    expect(await call('tasks:step-one')).toBe(await executed(stepId));
  });

  it.each(tools)('%s: a named routing edge (next.<label>) is not inlined either', async (_name, call) => {
    const branch = await mkNode('tasks:on-error', 'On error', 'BRANCH-ONLY-INSTRUCTIONS', { isRunnable: true });
    await mkEdge({ id: stepId, loc: 'tasks:step-one' }, 'next.error', branch);
    const text = await call('tasks:step-one', { subject: 'x' });
    expect(text).not.toContain('BRANCH-ONLY-INSTRUCTIONS');
    expect(text).toBe(await executed(stepId, { subject: 'x' }));
  });

  it.each(tools)('%s: content with a stray "{{" is returned as the executor returns it, not thrown', async (_name, call) => {
    const broken = await mkNode('tasks:broken', 'Broken', 'An unclosed {{ tag, and {{subject}} after it.', { isRunnable: true });
    const text = await call('tasks:broken', { subject: 'x' });
    expect(text).toBe(await executed(broken.id, { subject: 'x' }));
    expect(text).toContain('# Node: Broken'); // an answer, whatever Mustache made of the tag
  });

  it.each(tools)('%s: over a content resolution limit the tool refuses by name and returns nothing partial', async (_name, call) => {
    setResolutionLimits({ limits: { maxBytes: 8 } });
    const text = await call('tasks:step-one', { subject: 'the incident' });
    expect(text).toContain('CONTENT_RESOLUTION_LIMIT_EXCEEDED');
    expect(text).not.toContain('Review');
    expect(text).not.toContain(REFERENCE);
  });

  it('the tool admits string arguments only, so a null cannot reach the render', () => {
    const args = createTestableMcpServer(auth()).toolParamSchema('hadron_run_action', 'args');
    expect(() => args.parse({ subject: null })).toThrow();
    expect(args.parse({ subject: 'null' })).toEqual({ subject: 'null' });
  });
});

describe('#863: usage is recorded as before', () => {
  const events = (type: string) => db.usageEvent.count({ where: { type, memoryId: memId } });
  const settle = () => new Promise((r) => setTimeout(r, 150)); // the recorder writes after the response

  it('one action-run per call, and a read for the run node and each inlined target only', async () => {
    await viaAction('tasks:step-one', { subject: 'x' });
    await settle();
    expect(await events('action-run')).toBe(1);
    const reads = await db.usageEvent.findMany({ where: { type: 'read', memoryId: memId }, select: { nodeLoc: true } });
    expect(reads.map((r) => r.nodeLoc).sort()).toEqual(['docs:ref', 'tasks:step-one']); // not the next step: it was not returned
  });

  it('a refused render records neither', async () => {
    setResolutionLimits({ limits: { maxBytes: 8 } });
    await viaAction('tasks:step-one', { subject: 'x' });
    await settle();
    expect(await events('action-run')).toBe(0);
    expect(await events('read')).toBe(0);
  });
});
