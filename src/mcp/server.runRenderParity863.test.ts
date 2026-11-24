/**
 * #863 (cor:api:060:05, render vs execute) — the MCP run tools render the prompt `runTask` executes.
 *
 * `hadron_run_action` and `hadron_run_task`'s render path used an assembler of their own (now deleted): a literal
 * `replaceAll` per argument, with every outgoing edge inlined. `runTask` and the GraphQL `renderRunNode` preview use
 * `assembleRunNodePrompt`: a Mustache compile (the memory's default data, an unsupplied variable renders empty) and
 * no flow-routing (`next*`) edge inlined (D-MN-4: rails, not references). So a preview through MCP showed a prompt
 * that was never run, with the next step's instructions in it.
 *
 * The pins compare the tool's text with what `Mutation.runTask` (no `appRef`) returns, byte for byte (#4341).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
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

/**
 * #4341: what `Mutation.runTask` itself returns for this node and these args. Without `appRef` it is the render-only
 * branch, which returns the assembled bundle (cor:api:060:05: one assembly, so a rendering change moves both). Text
 * only: its usage events are not part of the parity (runTask records an `action-run`, the preview none).
 */
async function executed(loc: string, args?: Record<string, string>, memoryUrn: string = memUrn): Promise<string> {
  const ctx = { db, roles: ['ADMIN'], userId: ownerId, clientId: `user:${ownerId}` } as Context;
  return (await resolvers.Mutation.runTask({}, { nodeRef: `hrn:node:${memoryUrn}:${loc}`, ...(args ? { args } : {}) }, ctx)) as string;
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
    expect(text).toBe(await executed('tasks:step-one', { subject: 'the incident' }));
  });

  it.each(tools)('%s: what that means, spelled out', async (_name, call) => {
    const text = await call('tasks:step-one', { subject: 'the incident' });
    expect(text).toContain('Review the incident for Ada.[]'); // the memory default is used; an unsupplied variable renders empty
    expect(text).not.toContain('{{missing}}');
    expect(text).not.toContain(NEXT_STEP); // a routing edge is a rail, not a reference
    expect(text).toContain(REFERENCE); // an ordinary reference is still inlined
  });

  it.each(tools)('%s: with no args at all the same holds', async (_name, call) => {
    expect(await call('tasks:step-one')).toBe(await executed('tasks:step-one'));
  });

  it.each(tools)('%s: a named routing edge (next.<label>) is not inlined either', async (_name, call) => {
    const branch = await mkNode('tasks:on-error', 'On error', 'BRANCH-ONLY-INSTRUCTIONS', { isRunnable: true });
    await mkEdge({ id: stepId, loc: 'tasks:step-one' }, 'next.error', branch);
    const text = await call('tasks:step-one', { subject: 'x' });
    expect(text).not.toContain('BRANCH-ONLY-INSTRUCTIONS');
    expect(text).toBe(await executed('tasks:step-one', { subject: 'x' }));
  });

  it.each(tools)('%s: content with a stray "{{" is returned as the executor returns it, not thrown', async (_name, call) => {
    await mkNode('tasks:broken', 'Broken', 'An unclosed {{ tag, and {{subject}} after it.', { isRunnable: true });
    const text = await call('tasks:broken', { subject: 'x' });
    expect(text).toBe(await executed('tasks:broken', { subject: 'x' }));
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

describe('#863, #4689: a compile reads the run node\'s own memory, and follows a foreign URN include only where the reader may read', () => {
  const FOREIGN = 'FOREIGN-MEMORY-CONTENT-THE-CALLER-MAY-EVEN-READ';
  const mkOtherMemory = async () => {
    const org = await db.organization.findFirstOrThrow();
    const other = (await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: `Other-${generateId()}` }, { db, roles: ['ADMIN'], userId: ownerId } as Context)) as { id: string };
    return db.memory.findUniqueOrThrow({ where: { id: other.id }, select: { id: true, urn: true } });
  };

  it.each(tools)('%s: an include of a node in the same memory is spliced in, as the executor does', async (_name, call) => {
    await mkNode('snippets:tone', 'Tone', 'Be brief.');
    await mkNode('tasks:with-include', 'With include', 'Write to {{subject}}. {{> snippets:tone}}', { isRunnable: true });
    const text = await call('tasks:with-include', { subject: 'Ada' });
    expect(text).toContain('Write to Ada. Be brief.');
    expect(text).toBe(await executed('tasks:with-include', { subject: 'Ada' }));
  });

  it.each(tools)('%s: an include that names a readable node of ANOTHER memory by URN is spliced in, as the executor does (#4689)', async (_name, call) => {
    // The other memory belongs to the same owner, so the caller reads it directly: the render follows the tag under
    // the caller's own read access (cor:dmo:150:04), and equals what runTask returns.
    const other = await mkOtherMemory();
    await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'secret', name: 'secret', nodeType: 'info', content: FOREIGN, tags: [] } });
    await mkNode('tasks:crossing', 'Crossing', `Start. {{> hrn:node:${other.urn}:secret}} End. {{subject}}`, { isRunnable: true });
    const text = await call('tasks:crossing', { subject: 'x' });
    expect(text).toContain(`Start. ${FOREIGN} End. x`);
    expect(text).toBe(await executed('tasks:crossing', { subject: 'x' }));
    // A missing target in that same memory is the notice, and says nothing about what exists (cor:dmo:150:05).
    await mkNode('tasks:missing', 'Missing', `Start. {{> hrn:node:${other.urn}:no-such-node}} End. {{subject}}`, { isRunnable: true });
    const missing = await call('tasks:missing', { subject: 'x' });
    expect(missing).toContain('Start. [Include unavailable] End. x');
    expect(missing).toBe(await executed('tasks:missing', { subject: 'x' }));
  });

  it.each(tools)('%s: a {{name.field}} reference reads a node of the same memory only', async (_name, call) => {
    await mkNode('settings', 'settings', '', { data: { tone: 'formal' } });
    await mkNode('tasks:refs', 'Refs', 'Tone: {{settings.tone}}.', { isRunnable: true });
    const text = await call('tasks:refs');
    expect(text).toContain('Tone: formal.');
    expect(text).toBe(await executed('tasks:refs'));
  });
});

describe('#4341: a memory the caller cannot read, and a loc that also exists in another memory', () => {
  const HIDDEN = 'HIDDEN-CONTENT-OF-A-MEMORY-THE-CALLER-CANNOT-READ';
  let hiddenUrn: string;
  let hiddenId: string;
  const mkHidden = (loc: string, content: string, extra: Record<string, unknown> = {}) =>
    db.node.create({ data: { id: generateId(), memoryId: hiddenId, loc, name: loc, nodeType: 'info', content, tags: [], ...extra } as never });

  beforeEach(async () => {
    // Another person's private memory: the caller, a platform ADMIN and org ADMIN, cannot read it.
    const stranger = await db.user.create({ data: { githubId: 434101, githubUsername: `rp-stranger-${generateId()}`, roles: [] } });
    const org = await db.organization.findFirstOrThrow();
    const hidden = await db.memory.create({ data: {
      id: generateId(), name: 'Hidden', urn: `${org.urn}:hidden-${generateId()}`, class: 'private',
      userId: stranger.id, ownerUserId: stranger.id,
    } });
    hiddenId = hidden.id;
    hiddenUrn = hidden.urn;
  });

  it('the fixture memory is unreadable to the caller', async () => {
    expect(await canReadMemory(db, auth(), hiddenId)).toBe(false);
  });

  it.each(tools)('%s: a direct URN include into it is the notice, the same as a missing target, and equals runTask', async (_name, call) => {
    await mkHidden('secret', HIDDEN);
    await mkNode('tasks:direct', 'Direct', `Start. {{> hrn:node:${hiddenUrn}:secret}} End. {{subject}}`, { isRunnable: true });
    await mkNode('tasks:absent', 'Direct', `Start. {{> hrn:node:${hiddenUrn}:no-such-node}} End. {{subject}}`, { isRunnable: true });
    const text = await call('tasks:direct', { subject: 'x' });
    expect(text).not.toContain(HIDDEN);
    expect(text).toContain('Start. [Include unavailable] End. x');
    expect(text).toBe(await executed('tasks:direct', { subject: 'x' }));
    expect(await call('tasks:absent', { subject: 'x' })).toBe(text); // cor:dmo:150:05: no word on what exists
  });

  it.each(tools)('%s: a nested include that reaches into it is the notice at that level, and equals runTask', async (_name, call) => {
    await mkHidden('secret', HIDDEN);
    await mkNode('snippets:outer', 'Outer', `Outer before. {{> hrn:node:${hiddenUrn}:secret}} Outer after.`);
    await mkNode('tasks:nested', 'Nested', 'Start. {{> snippets:outer}} End.', { isRunnable: true });
    const text = await call('tasks:nested');
    expect(text).not.toContain(HIDDEN);
    expect(text).toContain('Start. Outer before. [Include unavailable] Outer after. End.'); // the readable level still resolves
    expect(text).toBe(await executed('tasks:nested'));
  });

  it.each(tools)('%s: a bare-loc include resolves in the run node\'s own memory, never the same loc elsewhere', async (_name, call) => {
    await mkHidden('snippets:only-there', HIDDEN);
    await mkHidden('snippets:both', HIDDEN);
    await mkNode('snippets:both', 'Both', 'OWN-SNIPPET');
    await mkNode('tasks:bare', 'Bare', 'A: {{> snippets:only-there}} B: {{> snippets:both}}', { isRunnable: true });
    const text = await call('tasks:bare');
    expect(text).not.toContain(HIDDEN);
    expect(text).toContain('A: [Include unavailable] B: OWN-SNIPPET');
    expect(text).toBe(await executed('tasks:bare'));
  });

  it.each(tools)('%s: a {{name.field}} reference never reads the same loc in another memory', async (_name, call) => {
    await mkHidden('palette', '', { data: { colour: HIDDEN } });
    await mkNode('tasks:palette', 'Palette', 'Colour: [{{palette.colour}}].', { isRunnable: true });
    const text = await call('tasks:palette');
    expect(text).not.toContain(HIDDEN);
    expect(text).toContain('Colour: [].');
    expect(text).toBe(await executed('tasks:palette'));
  });

  it('both tools: the default data comes from the run node\'s own memory only, never another memory\'s `data` node', async () => {
    // A second memory of the caller's with NO data node of its own, so another memory's `data` row is the only one a
    // lookup without its memoryId could find.
    await mkHidden('data', '', { data: { owner: HIDDEN } });
    const org = await db.organization.findFirstOrThrow();
    const bare = (await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: `Bare-${generateId()}` }, { db, roles: ['ADMIN'], userId: ownerId } as Context)) as { id: string };
    const bareUrn = (await db.memory.findUniqueOrThrow({ where: { id: bare.id }, select: { urn: true } })).urn;
    await db.node.create({ data: { id: generateId(), memoryId: bare.id, loc: 'tasks:owner', name: 'Owner', nodeType: 'info', content: 'Owner: [{{owner}}] [{{data.owner}}].', tags: [], isRunnable: true } as never });
    const ref = `hrn:node:${bareUrn}:tasks:owner`;
    for (const tool of ['hadron_run_action', 'hadron_run_task']) {
      const text = await createTestableMcpServer(auth()).callToolText(tool, { urn: ref });
      expect(text).not.toContain(HIDDEN);
      expect(text).toContain('Owner: [] [].');
      expect(text).toBe(await executed('tasks:owner', undefined, bareUrn));
    }
  });

  it.each(tools)('%s: an edge to a node of that memory is not inlined, and equals runTask', async (_name, call) => {
    const target = await mkHidden('docs:hidden-ref', HIDDEN);
    await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: stepId, targetId: target.id, loc: deriveEdgeLoc('tasks:step-one', 'depends-on', `hrn:node:${hiddenUrn}:docs:hidden-ref`), name: 'depends-on' } });
    const text = await call('tasks:step-one', { subject: 'x' });
    expect(text).not.toContain(HIDDEN);
    expect(text).toContain(REFERENCE); // the readable reference is still there
    expect(text).toBe(await executed('tasks:step-one', { subject: 'x' }));
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
