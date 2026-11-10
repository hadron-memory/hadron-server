/**
 * #1328 — the separately maintained MCP writers take the same attestation
 * check as GraphQL, and no MCP tool reaches the trusted portal path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let userId: string;
let memoryId: string;
let taskId: string;
let configId: string;
/** A sign-in JWT, the credential the portal holds: over MCP it earns nothing. */
const auth = () => ({ userId, roles: ['ADMIN'], clientId: `user:${userId}`, signInCredential: true }) as unknown as AuthContext;
const urn = (loc: string) => `hrn:node:attest-mcp:mem:${loc}`;
const claim = (revision = 1) => ({ task: taskId, revision });
const stored = (loc: string) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc, memoryId } } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-mcp', urn: 'attest-mcp' } });
  userId = (await db.user.create({ data: { githubId: 13281, githubUsername: 'attest-mcp', handle: 'attest-mcp' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'attest-mcp:mem', name: 'mem', class: 'knowledge' } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'task', name: 'Task', isRunnable: true } })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});

describe('#1328 MCP parity', () => {
  it('hadron_create_node and hadron_update_node refuse without a write and stamp a match', async () => {
    const srv = createTestableMcpServer(auth());
    expect(await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one' }))
      .toMatch(/authoring_attestation_missing/);
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    const first = await stored('a');
    expect(first).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    expect(await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'two', authoredWith: claim(1) }))
      .toMatch(/authoring_attestation_stale/);
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(0);
    await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'two', authoredWith: claim(2) });
    expect(await stored('a')).toMatchObject({ content: 'two', authoredByTask: taskId, authoredByRevision: 2 });
  });

  it('an upsert over a live governed node attests, and an identical one does not', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'one' });
    expect(await stored('a')).toMatchObject({ authoredByTask: taskId });
  });

  it('hadron_update_node_data forwards the claim to the shared seam', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    expect(await srv.callToolText('hadron_update_node_data', { nodeUrn: urn('a'), data: { k: 1 } })).toMatch(/authoring_attestation_missing/);
    await srv.callToolText('hadron_update_node_data', { nodeUrn: urn('a'), data: { k: 1 }, authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ data: { k: 1 }, authoredByTask: taskId });
  });

  it('hadron_replace_text forwards the claim and refuses as one batch', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'alpha', authoredWith: claim() });
    const args = { nodeUrns: [urn('a')], oldText: 'alpha', newText: 'beta', fields: ['content'] };
    expect(await srv.callToolText('hadron_replace_text', args)).toMatch(/authoring_attestation_missing/);
    expect((await stored('a')).content).toBe('alpha');
    await srv.callToolText('hadron_replace_text', { ...args, authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ content: 'beta', authoredByTask: taskId });
  });

  it('hadron_create_parent_node re-saving a governed section attests', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('section'), name: 'S', role: 'guide', content: 'one', authoredWith: claim() });
    const args = { urn: urn('section'), name: 'Renamed' };
    expect(await srv.callToolText('hadron_create_parent_node', args)).toMatch(/authoring_attestation_missing/);
    expect(await stored('section')).toMatchObject({ name: 'S' });
    await srv.callToolText('hadron_create_parent_node', { ...args, authoredWith: claim() });
    expect(await stored('section')).toMatchObject({ name: 'Renamed', authoredByTask: taskId });
  });

  it('the review door takes the claim, so the generic refusal does not trap an agent', async () => {
    await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'review', authorTaskId: taskId, authorTaskRequired: true } });
    const srv = createTestableMcpServer(auth());
    expect(await srv.callToolText('hadron_create_review', { urn: urn('r'), name: 'R', content: 'check' }))
      .toMatch(/authoring_attestation_missing/);
    await srv.callToolText('hadron_create_review', { urn: urn('r'), name: 'R', content: 'check', authoredWith: claim() });
    expect(await stored('r')).toMatchObject({ role: 'review', authoredByTask: taskId });
  });

  it('a rename on move is an authored name change and attests; a plain move carries', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: urn('b') });
    expect(await stored('b')).toMatchObject({ name: 'A', authoredByTask: taskId });
    expect(await srv.callToolText('hadron_move_node', { urn: urn('b'), targetUrn: urn('c'), renameToLeaf: true }))
      .toMatch(/authoring_attestation_missing/);
    expect(await stored('b')).toMatchObject({ name: 'A' });
    await srv.callToolText('hadron_move_node', { urn: urn('b'), targetUrn: urn('c'), renameToLeaf: true, authoredWith: claim() });
    expect(await stored('c')).toMatchObject({ name: 'c', authoredByTask: taskId });
  });

  // #3437 (m4): the in-handler door. Same slot, so `moveNodeSubtree` never runs.
  it('a rename in place attests: no claim changes nothing, and a claim stamps it', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    expect(await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: urn('a'), renameToLeaf: true }))
      .toMatch(/authoring_attestation_missing/);
    expect(await stored('a')).toMatchObject({ name: 'A', authoredByRevision: 1 });
    await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: urn('a'), renameToLeaf: true, authoredWith: claim(2) });
    expect(await stored('a')).toMatchObject({ name: 'a', authoredByTask: taskId, authoredByRevision: 2 });
  });

  describe('a rename out of a memory answers to the rules it leaves', () => {
    const other = (loc: string) => `hrn:node:attest-mcp:other:${loc}`;
    let otherId: string;
    const inOther = (loc: string) => db.node.findUnique({ where: { loc_memoryId: { loc, memoryId: otherId } } });
    const seed = async (srv: ReturnType<typeof createTestableMcpServer>, withChild: boolean) => {
      await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
      if (withChild) await srv.callToolText('hadron_create_node', { urn: urn('a:kid'), name: 'Kid', content: 'two' });
    };

    beforeEach(async () => {
      const source = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      otherId = (await db.memory.create({
        data: { id: generateId(), organizationId: source.organizationId, urn: 'attest-mcp:other', name: 'other', class: 'knowledge' },
      })).id;
    });

    // A node with a child goes through the subtree helper; a lone node may not. Both doors must hold.
    describe.each([['a lone node', false], ['a node with a child', true]])('%s', (_name, withChild) => {
      it('into an ungoverned memory: no claim is refused, nothing moves', async () => {
        const srv = createTestableMcpServer(auth());
        await seed(srv, withChild);
        expect(await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: other('b'), renameToLeaf: true }))
          .toMatch(/authoring_attestation_missing/);
        expect(await stored('a')).toMatchObject({ name: 'A' });
        expect(await inOther('b')).toBeNull();
      });

      it("into an ungoverned memory: the source rule's claim passes", async () => {
        const srv = createTestableMcpServer(auth());
        await seed(srv, withChild);
        await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: other('b'), renameToLeaf: true, authoredWith: claim() });
        // The stamp is the destination's: this destination has no rule, so nothing is claimed there.
        expect(await inOther('b')).toMatchObject({ name: 'b', authorshipKind: null, authoredByTask: null, authoredByRevision: null });
      });

      it('into a memory requiring a different task: one claim cannot meet both, so split it', async () => {
        const srv = createTestableMcpServer(auth());
        await seed(srv, withChild);
        const otherTask = await db.node.create({ data: { id: generateId(), memoryId: otherId, loc: 'task', name: 'T', isRunnable: true } });
        const otherConfig = await db.memoryConfig.create({ data: { id: generateId(), memoryId: otherId } });
        await db.nodeRoleRule.create({
          data: { id: generateId(), configId: otherConfig.id, role: 'guide', authorTaskId: otherTask.id, authorTaskRequired: true },
        });
        for (const authoredWith of [claim(), { task: otherTask.id, revision: 1 }]) {
          expect(await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: other('b'), renameToLeaf: true, authoredWith }))
            .toMatch(/authoring_attestation_wrong_task/);
        }
        expect(await inOther('b')).toBeNull();
      });
    });

    it('a plain move still carries: the address is not authored', async () => {
      const srv = createTestableMcpServer(auth());
      await seed(srv, false);
      await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: other('b') });
      expect(await inOther('b')).toMatchObject({ name: 'A', authoredByTask: taskId });
    });
  });
});
