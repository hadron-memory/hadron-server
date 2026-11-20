/**
 * #863 (cor:api:060:05, render vs execute) — the MCP run tools render the prompt `runTask` executes.
 *
 * `hadron_run_action` and `hadron_run_task`'s render path used an assembler of their own (now deleted): a literal
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
  const created = (await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: `Flow-${generateId()}` }, ctx)) as { id: string };
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

  it.each(tools)('%s: the compiled text counts toward the per-request size limit, as it does for runTask', async (_name, call) => {
    setResolutionLimits({ requestMaxBytes: 8 });
    const text = await call('tasks:step-one', { subject: 'the incident' });
    expect(text).toContain('CONTENT_RESOLUTION_LIMIT_EXCEEDED');
    expect(text).toContain('per-request');
    expect(text).not.toContain('Review');
  });

  it('the tool admits string arguments only, so a null cannot reach the render', () => {
    const args = createTestableMcpServer(auth()).toolParamSchema('hadron_run_action', 'args');
    expect(() => args.parse({ subject: null })).toThrow();
    expect(args.parse({ subject: 'null' })).toEqual({ subject: 'null' });
  });
});

describe('#863: the reads a compile makes stay inside the run node\'s own memory', () => {
  const FOREIGN = 'FOREIGN-MEMORY-CONTENT-THE-CALLER-MAY-EVEN-READ';

  it.each(tools)('%s: an include of a node in the same memory is spliced in, as the executor does', async (_name, call) => {
    await mkNode('snippets:tone', 'Tone', 'Be brief.');
    const withInclude = await mkNode('tasks:with-include', 'With include', 'Write to {{subject}}. {{> snippets:tone}}', { isRunnable: true });
    const text = await call('tasks:with-include', { subject: 'Ada' });
    expect(text).toContain('Write to Ada. Be brief.');
    expect(text).toBe(await executed(withInclude.id, { subject: 'Ada' }));
  });

  it.each(tools)('%s: an include that names a node of ANOTHER memory by URN is not resolved, readable or not', async (_name, call) => {
    // The other memory belongs to the same owner, so the caller could read it directly. The render still does not
    // follow the tag: a compile is given no reader filter for a foreign memory, so it must not turn a URN into a read.
    const org = await db.organization.findFirstOrThrow();
    const other = (await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: `Other-${generateId()}` }, { db, roles: ['ADMIN'], userId: ownerId } as Context)) as { id: string };
    const otherUrn = (await db.memory.findUniqueOrThrow({ where: { id: other.id }, select: { urn: true } })).urn;
    await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'secret', name: 'secret', nodeType: 'info', content: FOREIGN, tags: [] } });
    const crossing = await mkNode('tasks:crossing', 'Crossing', `Start. {{> hrn:node:${otherUrn}:secret}} End. {{subject}}`, { isRunnable: true });
    const text = await call('tasks:crossing', { subject: 'x' });
    expect(text).not.toContain(FOREIGN);
    expect(text).toContain('[Include unavailable]');
    expect(text).toBe(await executed(crossing.id, { subject: 'x' }));
    // A missing target reads the same: the notice says nothing about what exists.
    const missing = await mkNode('tasks:missing', 'Missing', `Start. {{> hrn:node:${otherUrn}:no-such-node}} End. {{subject}}`, { isRunnable: true });
    expect((await call('tasks:missing', { subject: 'x' })).replace('Missing', 'Crossing')).toBe(text);
  });

  it.each(tools)('%s: a {{name.field}} reference reads a node of the same memory only', async (_name, call) => {
    await mkNode('settings', 'settings', '', { data: { tone: 'formal' } });
    const refs = await mkNode('tasks:refs', 'Refs', 'Tone: {{settings.tone}}.', { isRunnable: true });
    const text = await call('tasks:refs');
    expect(text).toContain('Tone: formal.');
    expect(text).toBe(await executed(refs.id));
  });
});

describe('#863: usage is recorded as before', () => {
  const count = (where: Record<string, unknown>) => db.usageEvent.count({ where: { memoryId: memId, ...where } });
  // The usage recorder is fire-and-forget (it writes after the response), so poll for the writes to land instead of
  // reading after a fixed wait: the idiom of server.batchRead.test.ts, at most 50 x 20 ms.
  const landed = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('one action-run per call, and a read for the run node and each inlined target only', async () => {
    await viaAction('tasks:step-one', { subject: 'x' });
    await landed(async () => (await count({ type: 'action-run' })) >= 1 && (await count({ type: 'read' })) >= 2);
    expect(await count({ type: 'action-run' })).toBe(1);
    const reads = await db.usageEvent.findMany({ where: { type: 'read', memoryId: memId }, select: { nodeLoc: true } });
    expect(reads.map((r) => r.nodeLoc).sort()).toEqual(['docs:ref', 'tasks:step-one']); // not the next step: it was not returned
  });

  it('a refused render records neither', async () => {
    setResolutionLimits({ limits: { maxBytes: 8 } });
    expect(await viaAction('tasks:step-one', { subject: 'x' })).toContain('CONTENT_RESOLUTION_LIMIT_EXCEEDED');
    // Absence cannot be polled for. A later call that IS served is the marker: once its events have landed, the
    // recorder has had its turn for the refused call before it, and none of that call's events may be there.
    setResolutionLimits(null);
    const marker = await mkNode('tasks:marker', 'Marker', 'A plain body.', { isRunnable: true });
    await viaAction('tasks:marker');
    await landed(async () => (await count({ type: 'action-run', nodeId: marker.id })) >= 1 && (await count({ type: 'read', nodeId: marker.id })) >= 1);
    expect(await count({ type: 'action-run', nodeId: marker.id })).toBe(1); // the marker did land
    expect(await count({ type: 'action-run', nodeId: stepId })).toBe(0);
    expect(await count({ type: 'read', nodeId: stepId })).toBe(0);
    expect(await count({ type: 'read', nodeLoc: 'docs:ref' })).toBe(0);
  });
});
