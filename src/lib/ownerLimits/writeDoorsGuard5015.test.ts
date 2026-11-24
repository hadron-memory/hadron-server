/**
 * #5015 (Billing A7b, issue step 13): every write under `src` that adds a node is classified, so a new one cannot land
 * silently. A node insert (`.node.create|createMany|createManyAndReturn|upsert(`) and every `writeNodeCore(` call are found
 * by the scanner in `src/test/ownerLimitWriteSites5015.ts` (TypeScript-parsed, keyed by file and ENCLOSING FUNCTION, never
 * by line, so an unrelated edit does not fail this) and compared with the table below: a site found and not listed fails,
 * a site listed and not found fails. Fixtures are excluded by PLACE (`*.test.ts`, `src/test/**`, `src/lib/grants/*Fixtures*`).
 *
 * The writes that add a live node WITHOUT an insert (a restore, a move or merge into another owner, a revival) cannot be
 * found by a search; they are listed by hand in `NON_INSERT`, each asserted present in its file. Their completeness rests on
 * review, not on this test.
 *
 * Slice A7c (#5016) keeps a sibling table for memory, Agent and App creation (`writeDoorsGuard5016.test.ts`); the issue
 * asks for one file, so whichever of the two merges second folds its table into the other's.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanWriteSites, type WriteSite } from '../../test/ownerLimitWriteSites5015.js';

type InsertVerdict =
  | { n: number; kind: 'refuses'; because: string }
  | { n: number; kind: 'per-caller'; because: string }
  | { n: number; kind: 'counts-not-refused'; because: string };

const G = 'src/api/graphql/schema';

/** Node inserts, by `file#function`. A `refuses` site's file must call `requireNodeHeadroom(`. */
const INSERTS: Record<string, InsertVerdict> = {
  [`${G}/resolvers.mutation.node.ts#writeNodeCoreRaw`]: { n: 1, kind: 'per-caller', because: 'the node writer core: each caller states `ownerLimit` (WRITE_NODE_CORE below); the create and revive branches check under the loc lock' },
  'src/mcp/server.ts#createMcpServerInstance.tool(hadron_create_node)': { n: 1, kind: 'refuses', because: 'MCP inline create (plain or revive), checked after the loc lock and the authoritative collision read' },
  'src/mcp/server.ts#createMcpServerInstance.tool(hadron_create_parent_node)': { n: 1, kind: 'refuses', because: 'MCP inline parent create, checked only when no row exists (the upsert leaves a tombstone deleted)' },
  'src/controller/operations/cloneMemory.ts#cloneMemoryGraphInTx': { n: 1, kind: 'refuses', because: 'the whole clone batch against the new memory\'s owner, before the createMany (also reached by cloneAgent)' },
  'src/controller/operations/extractParentNode.ts#extractParentNodeGraph': { n: 1, kind: 'refuses', because: 'the copied rows against the new memory\'s owner; skipped when it is a move within one owner (net zero)' },
  'src/integrations/github/syncGraphFromGithub.ts#syncGraphFromGithubAsSystem': { n: 1, kind: 'refuses', because: 'the sync\'s net new live nodes, judged once at the end of its one transaction (alreadyWritten)' },
  [`${G}/resolvers.mutation.session.ts#writeRevisionRow`]: { n: 2, kind: 'per-caller', because: 'the Agent snapshot: createRevision refuses (mode refuse), restoreRevision\'s auto-save counts (mode count-only)' },
  [`${G}/resolvers.mutation.session.ts#sessionMutations.restoreRevision`]: { n: 1, kind: 'counts-not-refused', because: 'restoring an Agent snapshot; restoring is never refused (cor:acl:150:04), and the transaction takes no advisory key after a row lock (#3587)' },
  'src/controller/operations/createNode.ts#createNodeAsSystem.write': { n: 1, kind: 'counts-not-refused', because: 'a new memory\'s root node (cor:acl:150:04\'s never-refused list)' },
  [`${G}/resolvers.mutation.chat.ts#chatMutations.startChat`]: { n: 3, kind: 'counts-not-refused', because: 'chat roots and the first message; chat is never refused' },
  [`${G}/resolvers.mutation.chat.ts#chatMutations.sendChatMessage`]: { n: 1, kind: 'counts-not-refused', because: 'a chat message; chat is never refused' },
  [`${G}/resolvers.mutation.chat.ts#chatMutations.processChatResponse`]: { n: 2, kind: 'counts-not-refused', because: 'the assistant\'s reply in a chat; chat is never refused' },
  [`${G}/resolvers.mutation.chat.ts#chatMutations.saveChatSummary`]: { n: 1, kind: 'counts-not-refused', because: 'a chat summary; chat is never refused' },
  [`${G}/resolvers.teamChat.ts#postToChannelRoot`]: { n: 1, kind: 'counts-not-refused', because: 'a team chat or channel post; never refused' },
  'src/lib/channels.ts#ensureChannelWithRoot': { n: 3, kind: 'counts-not-refused', because: 'a channel\'s root nodes; creating a channel is never refused' },
  [`${G}/resolvers.comments.ts#insertComment`]: { n: 1, kind: 'counts-not-refused', because: 'a comment; never refused' },
  [`${G}/resolvers.teamWork.ts#bootstrapWorklog`]: { n: 1, kind: 'counts-not-refused', because: 'the worklog root; a work record is never refused' },
  [`${G}/resolvers.teamWork.ts#teamWorkMutations.recordTeamWork`]: { n: 1, kind: 'counts-not-refused', because: 'a worklog record; never refused' },
  'src/lib/contextReset/contextReset.ts#registerContextResetRecovery': { n: 1, kind: 'counts-not-refused', because: 'a context-reset checkpoint (a session handoff); never refused' },
  'src/lib/agentSkeleton.ts#seedAgentSkeleton': { n: 1, kind: 'counts-not-refused', because: 'an Agent\'s skeleton parents, part of creating the Agent (its own `agents` key is A7c)' },
};

/** `writeNodeCore(` callers, by `file#function`: the `ownerLimit` literals each states, sorted (`?` = not a literal). */
const WRITE_NODE_CORE: Record<string, { limits: string[]; because: string }> = {
  [`${G}/resolvers.mutation.node.ts#nodeMutations.createNode`]: { limits: ['refuse'], because: 'createNode' },
  [`${G}/resolvers.mutation.node.ts#nodeMutations`]: { limits: ['refuse'], because: 'the governed-kind create doors, generated from GOVERNED_KINDS' },
  [`${G}/resolvers.mutation.node.ts#createNodeInInstallMemory`]: { limits: ['refuse'], because: 'createNode into an App\'s install memory' },
  [`${G}/resolvers.mutation.node.ts#nodeMutations.cloneNode`]: { limits: ['refuse'], because: 'cloneNode' },
  [`${G}/resolvers.mutation.importNode.ts#importNode.store`]: { limits: ['refuse'], because: 'importNode (update or upsert)' },
  'src/controller/operations/createAssetReferenceNode.ts#createAssetReferenceNode': { limits: ['refuse'], because: 'an asset\'s reference node' },
  'src/lib/runner/tools/nodeTools.ts#hadronCreateNode.execute': { limits: ['refuse'], because: 'run tool create; the refusal is returned to the model (ownerLimitToolError)' },
  'src/lib/runner/tools/storeTools.ts#hadronStoreFile.execute': { limits: ['refuse'], because: 'hadron_store_file\'s reference node; returned to the model, asset row and object removed' },
  [`${G}/resolvers.specCorpus.ts#specCorpusMutations.reserveSpecCitation`]: { limits: ['refuse'], because: 'a reserved spec citation' },
  [`${G}/resolvers.specCorpus.ts#specCorpusMutations.allocateSpecNode`]: { limits: ['refuse'], because: 'an allocated spec node' },
  [`${G}/resolvers.questions.ts#questionMutations.createQuestionLog`]: { limits: ['count-only'], because: 'a question log; asking a question is never refused' },
  [`${G}/resolvers.questions.ts#questionMutations.askQuestion`]: { limits: ['count-only'], because: 'a question asked; never refused' },
  [`${G}/resolvers.mutation.session.ts#writeSessionHandoff`]: { limits: ['count-only', 'count-only'], because: 'the session handoff parent and record; never refused' },
  [`${G}/compileBootPrompt.ts#decide`]: { limits: ['count-only'], because: 'a compiled boot prompt; never refused' },
  [`${G}/resolvers.teamRole.ts#writeTeamRole`]: { limits: ['?'], because: 'a team role node; its options object is built beside the call and states count-only (asserted below)' },
  'src/jobs/appRunDeps.ts#makeProdRunDeps.writeOutput': { limits: ['count-only'], because: 'a run\'s output node; never refused' },
  // Update mode: the value is never read (an update adds no node); count-only by convention.
  [`${G}/resolvers.mutation.node.ts#updateNodeCore`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.node.ts#updateNodePropertiesWith`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.node.ts#mergePropertiesAndWrite`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.node.ts#nodeMutations.updateNodeData`]: { limits: ['count-only'], because: 'update only' },
  'src/lib/runner/tools/nodeTools.ts#hadronUpdateNode.execute': { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.specCorpus.ts#rewriteWithRetry`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.retireSpec.ts#retireSpecDoor`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.amendQuestion`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.withdrawQuestion`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.purgeUnansweredQuestion`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.setQuestionLogDeciders`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.questions.ts#answerAct`]: { limits: ['count-only'], because: 'update only' },
};

/**
 * Writes that add a live node without an insert, listed by hand (a search cannot find them): each names its file and a
 * marker that must be present. `refuses` also requires the file to call `requireNodeHeadroom(`.
 */
const NON_INSERT: Array<{ door: string; file: string; marker: string; kind: 'refuses' | 'counts-not-refused' | 'disabled' | 'elsewhere'; because: string }> = [
  { door: 'restoreNode (MCP hadron_restore_node delegates)', file: `${G}/resolvers.recovery.ts`, marker: 'requireNodeHeadroom(tx, { memoryId: memory.id', kind: 'refuses', because: 'un-deleting a node; the threads restored with it are counted, not refused' },
  { door: 'moveNodeSubtree (GraphQL moveNode, MCP hadron_move_node)', file: 'src/lib/nodeSubtreeMove.ts', marker: 'sameMemoryOwner', kind: 'refuses', because: 'a move into another owner: the subtree plus the carried comment threads' },
  { door: 'MCP hadron_move_node', file: 'src/mcp/server.ts', marker: 'ownerLimitCaller: ownerLimitCaller(auth)', kind: 'refuses', because: 'every memory-changing branch goes through moveNodeSubtree with the caller; the same-slot branch never changes memory' },
  { door: 'mergeMemories', file: 'src/controller/operations/mergeMemories.ts', marker: 'sameMemoryOwner', kind: 'refuses', because: 'a merge into another owner: a whole-relocation preflight plus the authoritative per-batch check' },
  { door: 'replaceSubtree', file: `${G}/resolvers.mutation.node.ts`, marker: 'replaceSubtree is unavailable', kind: 'disabled', because: 'disabled and throws today; a re-enable must classify it' },
  { door: 'account merge', file: 'src/lib/mergeOwnerNamespacedUrns.ts', marker: 'ownerUserId: targetUserId', kind: 'counts-not-refused', because: 'an account merge re-owns everything; the survivor may end over a cap (gate ruling 13-r)' },
  { door: 'channel root revival', file: 'src/lib/channels.ts', marker: 'deletedAt: null', kind: 'counts-not-refused', because: 'a channel\'s root brought back; creating a channel is never refused' },
  { door: 'worklog root revival', file: `${G}/resolvers.teamWork.ts`, marker: 'deletedAt: null', kind: 'counts-not-refused', because: 'the worklog root brought back; a work record is never refused' },
  { door: 'transferMemoryOwnership', file: `${G}/resolvers.mutation.memoryTransfer.ts`, marker: 'transferMemoryOwnership', kind: 'elsewhere', because: 'slice A7c (#5016) takes `memories` and `nodes` in one multi-key call' },
];

const keyOf = (s: WriteSite) => `${s.file}#${s.fn}`;

describe('#5015 every node write door under src is classified', () => {
  const sites = scanWriteSites();

  it('CONTROL: the scan finds the sites known to exist', () => {
    const keys = new Set(sites.map(keyOf));
    for (const k of [`${G}/resolvers.mutation.node.ts#writeNodeCoreRaw`, 'src/controller/operations/cloneMemory.ts#cloneMemoryGraphInTx',
      'src/lib/runner/tools/nodeTools.ts#hadronCreateNode.execute']) expect(keys).toContain(k);
  });

  it('every node insert is listed, by file, function and count (and nothing listed is gone)', () => {
    const found: Record<string, number> = {};
    for (const s of sites) if (s.kind === 'insert') found[keyOf(s)] = (found[keyOf(s)] ?? 0) + 1;
    expect(found).toEqual(Object.fromEntries(Object.entries(INSERTS).map(([k, v]) => [k, v.n])));
  });

  it('every writeNodeCore call is listed with the ownerLimit it states', () => {
    const found: Record<string, string[]> = {};
    for (const s of sites) if (s.kind === 'writeNodeCore') (found[keyOf(s)] ??= []).push(s.ownerLimit!);
    for (const v of Object.values(found)) v.sort();
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITE_NODE_CORE).map(([k, v]) => [k, [...v.limits].sort()])));
  });

  it('a refusing insert\'s file really calls the helper', () => {
    for (const [k, v] of Object.entries(INSERTS)) {
      if (v.kind !== 'refuses' && v.kind !== 'per-caller') continue;
      expect(readFileSync(k.split('#')[0], 'utf8'), k).toMatch(/requireNodeHeadroom\(/);
    }
  });

  it('the team role writer\'s non-literal options state count-only', () => {
    const src = readFileSync(`${G}/resolvers.teamRole.ts`, 'utf8');
    expect(src).toMatch(/ownerLimit: 'count-only'/);
    expect(src).not.toMatch(/ownerLimit: 'refuse'/);
  });

  it('every hand-listed non-insert door is present in its file, and a refusing one calls the helper', () => {
    for (const d of NON_INSERT) {
      const src = readFileSync(d.file, 'utf8');
      expect(src, d.door).toContain(d.marker);
      if (d.kind === 'refuses') expect(src, d.door).toMatch(/requireNodeHeadroom\(/);
    }
  });

  it('every entry says why', () => {
    for (const [k, v] of [...Object.entries(INSERTS), ...Object.entries(WRITE_NODE_CORE)]) expect(v.because.length, k).toBeGreaterThan(5);
    for (const d of NON_INSERT) expect(d.because.length, d.door).toBeGreaterThan(15);
  });
});
