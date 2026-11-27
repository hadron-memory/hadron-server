/**
 * #5016 (Billing A7c): every creation site of a memory, Agent or App under `src` is classified, so a new one cannot land silently:
 * "refuses" (it asks `requireOwnerHeadroom`), "free, because ..." or "counts, not refused, because ...". The check is by file and
 * count, not by line, so an unrelated edit does not move it. Fixtures are excluded by PLACE (`src/test/`, a `*Fixtures*` file). Slice A7b
 * (#5015) adds the node tables below (every node insert and `writeNodeCore(` call).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanWriteSites, type WriteSite } from '../../test/ownerLimitWriteSites5015.js';

const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const ASKS_HELPER = /\brequireOwnerHeadroom(?:Many)?\s*\(|\bextraOwnerChecks\s*:/;

type Verdict = { n: number; kind: 'refuses' | 'free' | 'counts-not-refused'; because: string; asks?: string };
const SITES: Record<string, Verdict> = {
  'src/api/graphql/schema/resolvers.mutation.memory.ts': { n: 1, kind: 'refuses', because: 'createMemory: every class it accepts is free-standing and counts', asks: 'memories' },
  'src/controller/operations/cloneMemory.ts': { n: 1, kind: 'refuses', because: 'cloneMemory: counts when the copy\'s class does; a cloneAgent system memory is free', asks: 'memories' },
  'src/controller/operations/extractParentNode.ts': { n: 1, kind: 'refuses', because: 'extractParentNodeToMemory: the new memory counts for the target organization', asks: 'memories' },
  'src/api/graphql/schema/resolvers.mutation.agent.ts': { n: 2, kind: 'refuses', because: 'createAgent: the Agent asks `agents`; its system memory (class system) is free', asks: 'agents' },
  'src/lib/agentClone/cloneAgent.ts': { n: 1, kind: 'refuses', because: 'cloneAgent: the Agent asks `agents`, passed into cloneMemoryGraphInTx\'s one multi-key call', asks: 'agents' },
  'src/api/graphql/schema/resolvers.mutation.app.ts': { n: 2, kind: 'refuses', because: 'createApp: the App and each dependency App ask `apps`', asks: 'apps' },
  'src/api/graphql/schema/resolvers.mutation.appMemory.ts': { n: 2, kind: 'free', because: 'a memory inside an App (app_id set) is not in the `memories` count' },
  'src/api/graphql/schema/installMemory.ts': { n: 1, kind: 'free', because: 'an install memory is not in the `memories` count' },
  'src/api/graphql/schema/chat-scope.ts': { n: 1, kind: 'free', because: 'the shared App-class memory (class app) is not in the `memories` count' },
  'src/api/graphql/schema/resolvers.worker.ts': { n: 1, kind: 'free', because: 'a worker memory is App-class and not in the `memories` count' },
  'src/api/graphql/schema/resolvers.mutation.session.ts': { n: 2, kind: 'free', because: 'startAgentSession memories carry app_id (class app/personal inside an App) and are never refused' },
  'src/api/graphql/schema/resolvers.mutation.chat.ts': { n: 1, kind: 'counts-not-refused', because: 'startChat with no matching App creates a counted knowledge memory for the Agent\'s organization; chat is never refused (gate ruling 2)' },
};
/**
 * Writes that change what an owner holds WITHOUT an insert (a restore, a class change, an owner move, a re-parent). Each names the file
 * and a marker, and says whether it asks. No restore of a deleted memory, Agent or App exists (cor:dmo:050:21: no undelete).
 */
const MOVES: Array<{ file: string; marker: string; kind: 'refuses' | 'free' | 'counts-not-refused'; because: string }> = [
  { file: 'src/api/graphql/schema/resolvers.mutation.memoryTransfer.ts', marker: 'requireOwnerHeadroomMany', kind: 'refuses', because: 'transferMemoryOwnership: the receiving owner takes the memory and its live nodes' },
  { file: 'src/api/graphql/schema/resolvers.mutation.agent.ts', marker: "class: 'system'", kind: 'free', because: 'promoting a memory to an Agent\'s system memory takes it out of the counted set' },
  { file: 'src/lib/mergeOwnerNamespacedUrns.ts', marker: 'ownerUserId: targetUserId', kind: 'counts-not-refused', because: 'an account merge re-owns everything; the survivor may end over a cap (decision r)' },
  { file: 'src/controller/operations/detachAppOwnerMemories.ts', marker: 'appId', kind: 'counts-not-refused', because: 'hard-deleting an App detaches its personal/private memories (app_id to null), which then count as free-standing; a deletion side effect, never refused' },
  { file: 'src/api/graphql/schema/appInstallState.ts', marker: 'uninstalledAt', kind: 'free', because: 'an uninstalled App keeps counting and reinstalling it adds nothing' },
];
const WRITE = /\.(memory|agent|app)\.(create|createMany|createManyAndReturn|upsert)\(/g;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === 'generated' ? [] : walk(p)) : [p];
});
const isFixture = (p: string) => p.startsWith('src/test/') || /Fixtures/.test(p);
const found = () => {
  const out: Record<string, number> = {};
  for (const p of walk('src')) {
    if (!p.endsWith('.ts') || p.endsWith('.test.ts') || isFixture(p)) continue;
    const n = (readFileSync(p, 'utf8').match(WRITE) ?? []).length;
    if (n) out[p] = n;
  }
  return out;
};

describe('#5016 every memory, Agent and App creation site under src is classified', () => {
  it('the table and the source agree, by file and count', () => {
    expect(found()).toEqual(Object.fromEntries(Object.entries(SITES).map(([p, v]) => [p, v.n])));
  });

  it('a refusing site names the key it asks and really calls the helper', () => {
    for (const [p, v] of Object.entries(SITES)) {
      if (v.kind !== 'refuses') continue;
      const src = readFileSync(p, 'utf8');
      // #5145: a call site or the property form in CODE; a comment that only names the helper must not satisfy it.
      expect(withoutComments(src), p).toMatch(ASKS_HELPER);
      expect(src, p).toContain(`'${v.asks}'`);
    }
  });

  it('every non-insert move is classified, exists in its file, and a refusing one asks', () => {
    for (const m of MOVES) {
      const src = readFileSync(m.file, 'utf8');
      expect(src, m.file).toContain(m.marker);
      if (m.kind === 'refuses') expect(src, m.file).toMatch(/requireOwnerHeadroom/);
      expect(m.because.length, m.file).toBeGreaterThan(15);
    }
  });

  it('every entry says why', () => {
    for (const [p, v] of Object.entries(SITES)) expect(v.because.length, p).toBeGreaterThan(15);
  });
});

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
 */
type InsertVerdict =
  | { n: number; kind: 'refuses'; because: string }
  | { n: number; kind: 'per-caller'; because: string }
  | { n: number; kind: 'counts-not-refused'; because: string };

const G = 'src/api/graphql/schema';
/** A door asks for `nodes` through the one-key helper or in its one multi-key call. */
const ASKS_NODES = /requireNodeHeadroom\(|requireOwnerHeadroomMany\(/;

/** Node inserts, by `file#function`. A `refuses` site's file must ask (`ASKS_NODES`). */
const INSERTS: Record<string, InsertVerdict> = {
  [`${G}/resolvers.mutation.node.ts#writeNodeCoreRaw`]: { n: 1, kind: 'per-caller', because: 'the node writer core: each caller states `ownerLimit` (WRITE_NODE_CORE below); the create and revive branches check under the loc lock' },
  'src/mcp/server.ts#createMcpServerInstance.tool(hadron_create_node)': { n: 1, kind: 'refuses', because: 'MCP inline create (plain or revive), checked after the loc lock and the authoritative collision read' },
  'src/mcp/server.ts#createMcpServerInstance.tool(hadron_create_parent_node)': { n: 1, kind: 'refuses', because: 'MCP inline parent create, checked only when no row exists (the upsert leaves a tombstone deleted)' },
  'src/controller/operations/cloneMemory.ts#cloneMemoryGraphInTx': { n: 1, kind: 'refuses', because: 'the whole clone batch against the new memory\'s owner, before the createMany (also reached by cloneAgent)' },
  'src/controller/operations/extractParentNode.ts#extractParentNodeGraph': { n: 1, kind: 'refuses', because: 'the copied rows against the new memory\'s owner; asked with amount 0 when it is a move within one owner (net zero), which the call skips' },
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

/**
 * `writeNodeCore(` callers, by `file#function`: the `ownerLimit` literals each states, sorted (`?` = not a literal), and
 * (#5019) the `sizeCeiling` ones: omitted = all `check` (caller content); `skip` = platform-composed, a copy, or a door with
 * its own limit (cor:dmo:060:19).
 */
const WRITE_NODE_CORE: Record<string, { limits: string[]; size?: string[]; because: string }> = {
  [`${G}/resolvers.mutation.node.ts#nodeMutations.createNode`]: { limits: ['refuse'], because: 'createNode' },
  [`${G}/resolvers.mutation.node.ts#nodeMutations`]: { limits: ['refuse'], because: 'the governed-kind create doors, generated from GOVERNED_KINDS' },
  [`${G}/resolvers.mutation.node.ts#createNodeInInstallMemory`]: { limits: ['refuse'], because: 'createNode into an App\'s install memory' },
  [`${G}/resolvers.mutation.node.ts#nodeMutations.cloneNode`]: { limits: ['refuse'], size: ['skip'], because: 'cloneNode' },
  [`${G}/resolvers.mutation.importNode.ts#importNode.store`]: { limits: ['refuse'], because: 'importNode (update or upsert)' },
  'src/controller/operations/createAssetReferenceNode.ts#createAssetReferenceNode': { limits: ['refuse'], because: 'an asset\'s reference node' },
  'src/lib/runner/tools/nodeTools.ts#hadronCreateNode.execute': { limits: ['refuse'], because: 'run tool create; the refusal is returned to the model (createRefusalToolError)' },
  'src/lib/runner/tools/storeTools.ts#hadronStoreFile.execute': { limits: ['refuse'], because: 'hadron_store_file\'s reference node; returned to the model, asset row and object removed' },
  [`${G}/resolvers.specCorpus.ts#specCorpusMutations.reserveSpecCitation`]: { limits: ['refuse'], size: ['skip'], because: 'a reserved spec citation' },
  [`${G}/resolvers.specCorpus.ts#specCorpusMutations.allocateSpecNode`]: { limits: ['refuse'], size: ['skip'], because: 'an allocated spec node' },
  [`${G}/resolvers.questions.ts#questionMutations.createQuestionLog`]: { limits: ['count-only'], size: ['skip'], because: 'a question log; asking a question is never refused' },
  [`${G}/resolvers.questions.ts#questionMutations.askQuestion`]: { limits: ['count-only'], size: ['skip'], because: 'a question asked; never refused' },
  [`${G}/resolvers.mutation.session.ts#writeSessionHandoff`]: { limits: ['count-only', 'count-only'], size: ['skip', 'skip'], because: 'the session handoff parent and record; never refused' },
  [`${G}/compileBootPrompt.ts#decide`]: { limits: ['count-only'], size: ['skip'], because: 'a compiled boot prompt; never refused' },
  [`${G}/resolvers.teamRole.ts#writeTeamRole`]: { limits: ['?'], size: ['?'], because: 'a team role node; its options object is built beside the call and states count-only (asserted below)' },
  'src/jobs/appRunDeps.ts#makeProdRunDeps.writeOutput': { limits: ['count-only'], size: ['skip'], because: 'a run\'s output node; never refused' },
  // Update mode: the value is never read (an update adds no node); count-only by convention.
  [`${G}/resolvers.mutation.node.ts#updateNodeCore`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.node.ts#updateNodePropertiesWith`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.node.ts#mergePropertiesAndWrite`]: { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.mutation.node.ts#nodeMutations.updateNodeData`]: { limits: ['count-only'], because: 'update only' },
  'src/lib/runner/tools/nodeTools.ts#hadronUpdateNode.execute': { limits: ['count-only'], because: 'update only' },
  [`${G}/resolvers.specCorpus.ts#rewriteWithRetry`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
  [`${G}/resolvers.mutation.retireSpec.ts#retireSpecDoor`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.amendQuestion`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.withdrawQuestion`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.purgeUnansweredQuestion`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
  [`${G}/resolvers.questions.ts#questionMutations.setQuestionLogDeciders`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
  [`${G}/resolvers.questions.ts#answerAct`]: { limits: ['count-only'], size: ['skip'], because: 'update only' },
};

/**
 * Writes that add a live node without an insert, listed by hand (a search cannot find them): each names its file and a
 * marker that must be present. `refuses` also requires the file to ask (`ASKS_NODES`).
 */
const NON_INSERT: Array<{ door: string; file: string; marker: string; kind: 'refuses' | 'counts-not-refused' | 'disabled'; because: string }> = [
  { door: 'restoreNode (MCP hadron_restore_node delegates)', file: `${G}/resolvers.recovery.ts`, marker: 'requireNodeHeadroom(tx, { memoryId: memory.id', kind: 'refuses', because: 'un-deleting a node; the threads restored with it are counted, not refused' },
  { door: 'moveNodeSubtree (GraphQL moveNode, MCP hadron_move_node)', file: 'src/lib/nodeSubtreeMove.ts', marker: 'sameMemoryOwner', kind: 'refuses', because: 'a move into another owner: the subtree plus the carried comment threads' },
  { door: 'MCP hadron_move_node', file: 'src/mcp/server.ts', marker: 'ownerLimitCaller: ownerLimitCaller(auth)', kind: 'refuses', because: 'every memory-changing branch goes through moveNodeSubtree with the caller; the same-slot branch never changes memory' },
  { door: 'mergeMemories', file: 'src/controller/operations/mergeMemories.ts', marker: 'sameMemoryOwner', kind: 'refuses', because: 'a merge into another owner: a whole-relocation preflight plus the authoritative per-batch check' },
  { door: 'replaceSubtree', file: `${G}/resolvers.mutation.node.ts`, marker: 'replaceSubtree is unavailable', kind: 'disabled', because: 'disabled and throws today; a re-enable must classify it' },
  { door: 'account merge', file: 'src/lib/mergeOwnerNamespacedUrns.ts', marker: 'ownerUserId: targetUserId', kind: 'counts-not-refused', because: 'an account merge re-owns everything; the survivor may end over a cap (gate ruling 13-r)' },
  { door: 'channel root revival', file: 'src/lib/channels.ts', marker: 'deletedAt: null', kind: 'counts-not-refused', because: 'a channel\'s root brought back; creating a channel is never refused' },
  { door: 'worklog root revival', file: `${G}/resolvers.teamWork.ts`, marker: 'deletedAt: null', kind: 'counts-not-refused', because: 'the worklog root brought back; a work record is never refused' },
  { door: 'transferMemoryOwnership', file: `${G}/resolvers.mutation.memoryTransfer.ts`, marker: "key: 'nodes'", kind: 'refuses', because: 'the memory\'s live nodes, in the one multi-key call with `memories` and `assetBytes` (#5016)' },
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

  it('#5019: every writeNodeCore call is listed with the sizeCeiling it states', () => {
    const found: Record<string, string[]> = {};
    for (const s of sites) if (s.kind === 'writeNodeCore') (found[keyOf(s)] ??= []).push(s.sizeCeiling!);
    for (const v of Object.values(found)) v.sort();
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITE_NODE_CORE).map(([k, v]) => [k, v.size ?? v.limits.map(() => 'check')])));
    const role = readFileSync(`${G}/resolvers.teamRole.ts`, 'utf8');
    expect(role.match(/sizeCeiling: 'check'/g)).toHaveLength(2);
    expect(role).not.toMatch(/sizeCeiling: 'skip'/);
  });

  it('a refusing insert\'s file really calls the helper', () => {
    for (const [k, v] of Object.entries(INSERTS)) {
      if (v.kind !== 'refuses' && v.kind !== 'per-caller') continue;
      expect(readFileSync(k.split('#')[0], 'utf8'), k).toMatch(ASKS_NODES);
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
      if (d.kind === 'refuses') expect(src, d.door).toMatch(ASKS_NODES);
    }
  });

  it('every entry says why', () => {
    for (const [k, v] of [...Object.entries(INSERTS), ...Object.entries(WRITE_NODE_CORE)]) expect(v.because.length, k).toBeGreaterThan(5);
    for (const d of NON_INSERT) expect(d.because.length, d.door).toBeGreaterThan(15);
  });
});

describe('#5015/#5016 a door that needs several owner-limit keys takes them in one call', () => {
  it.each([
    ['src/controller/operations/cloneMemory.ts', 1],
    ['src/controller/operations/extractParentNode.ts', 1],
    ['src/lib/agentClone/cloneAgent.ts', 0],
  ])('%s: no second owner-limit lock', (file, many) => {
    const src = readFileSync(file, 'utf8');
    expect(src.split('requireOwnerHeadroomMany(').length - 1).toBe(many);
    expect(src).not.toMatch(/requireOwnerHeadroom\(|requireNodeHeadroom\(/);
  });
});

/**
 * #5019 (Billing A11, cor:dmo:060:19): every file under `src` that writes a node's row outside `writeNodeCore` is classified at
 * the size ceiling, by file and count of direct writes (`.node.update|updateMany|upsert|create|createMany(`), so a new content
 * door cannot land unclassified. `checks` = the number of size-helper calls the file makes; 0 says why.
 */
const CONTENT_WRITES: Record<string, { n: number; checks: number; because: string }> = {
  'src/api/graphql/schema/resolvers.channel.ts': { n: 1, checks: 0, because: 'a channel operation: no caller body through this write' },
  'src/api/graphql/schema/resolvers.comments.ts': { n: 3, checks: 0, because: 'comments have their own cap, COMMENT_BODY_MAX (gate, section 11 ruling 5)' },
  'src/api/graphql/schema/resolvers.mutation.chat.ts': { n: 10, checks: 0, because: 'chat roots, messages, replies and summaries: conversation the platform writes (plan decision k)' },
  'src/api/graphql/schema/resolvers.mutation.memory.ts': { n: 3, checks: 0, because: 'memory-level operations (soft delete, re-encryption of stored rows): no new content' },
  'src/api/graphql/schema/resolvers.mutation.node.ts': { n: 11, checks: 6, because: 'the core writer (create, revive, update), searchReplaceInNodes, mergeNodes and restoreNodeRevision check; the rest are placeholder fill, revSeq, deletes' },
  'src/api/graphql/schema/resolvers.mutation.session.ts': { n: 6, checks: 0, because: 'Agent snapshot and its restore (platform copy of nodes, section 11 ruling 7), revision publish and delete' },
  'src/api/graphql/schema/resolvers.questions.ts': { n: 1, checks: 0, because: 'question text has its own limits (LONG_TEXT_MAX)' },
  'src/api/graphql/schema/resolvers.recovery.ts': { n: 1, checks: 0, because: 'restoreNode un-deletes a stored node: no new content' },
  'src/api/graphql/schema/resolvers.searchReplaceSpec.ts': { n: 1, checks: 1, because: 'searchReplaceInSpecNodes: every changed node, before any write' },
  'src/api/graphql/schema/resolvers.specCorpus.ts': { n: 3, checks: 0, because: 'placeholder marking and renumber bookkeeping: no caller content' },
  'src/api/graphql/schema/resolvers.teamChat.ts': { n: 1, checks: 0, because: 'team chat and channel posts have their own cap, TEAM_CHAT_BODY_MAX_CHARS' },
  'src/api/graphql/schema/resolvers.teamWork.ts': { n: 3, checks: 0, because: 'worklog root and records: platform bookkeeping' },
  'src/controller/operations/cloneMemory.ts': { n: 1, checks: 0, because: 'a copy adds no new content' },
  'src/controller/operations/createNode.ts': { n: 1, checks: 0, because: 'a new memory\'s root node, composed by the platform' },
  'src/controller/operations/extractParentNode.ts': { n: 2, checks: 0, because: 'a copy (and the soft delete of the sources): no new content' },
  'src/controller/operations/mergeMemories.ts': { n: 2, checks: 0, because: 'a memory merge folds and relocates existing nodes (plan: not checked)' },
  'src/integrations/github/syncGraphFromGithub.ts': { n: 3, checks: 1, because: 'each file is judged before its row is touched; over the ceiling it is skipped and reported' },
  'src/jobs/embedNodes.ts': { n: 3, checks: 0, because: 'embedding bookkeeping columns only' },
  'src/lib/agentSkeleton.ts': { n: 1, checks: 0, because: 'an Agent\'s skeleton parents, composed by the platform' },
  'src/lib/channels.ts': { n: 10, checks: 0, because: 'channel roots and their revival or deletion, composed by the platform' },
  'src/lib/chatRoot.ts': { n: 3, checks: 0, because: 'a chat\'s engine state, written by the platform' },
  'src/lib/comments/lifecycle.ts': { n: 2, checks: 0, because: 'comment thread deletion and restore: no content' },
  'src/lib/comments/merge.ts': { n: 1, checks: 0, because: 'comment threads carried by a merge: no new content' },
  'src/lib/contextReset/contextReset.ts': { n: 1, checks: 0, because: 'checkpoints have their own cap, CHECKPOINT_CONTENT_MAX_BYTES' },
  'src/lib/nodeApproval.ts': { n: 2, checks: 0, because: 'approval and mint columns only' },
  'src/lib/nodeRevisionSnapshot.ts': { n: 3, checks: 0, because: 'revision counters and fingerprints only' },
  'src/lib/nodeSubtreeMove.ts': { n: 3, checks: 0, because: 'a move changes the address, not the content' },
  'src/lib/tombstoneArchive.ts': { n: 1, checks: 0, because: 're-addresses a tombstone: no content' },
  'src/mcp/server.ts': { n: 8, checks: 4, because: 'hadron_create_node, hadron_update_node and both hadron_create_parent_node branches check; the rest are deletes, moves and vector bookkeeping' },
  'src/services/embedding/obligation.ts': { n: 1, checks: 0, because: 'embedding bookkeeping columns only' },
  'src/services/embedding/vectors.ts': { n: 1, checks: 0, because: 'embedding bookkeeping columns only' },
};
const DIRECT_WRITE = /\.node\.(update|updateMany|updateManyAndReturn|upsert|create|createMany|createManyAndReturn)\(/g;
const SIZE_CALL = /\b(assertNodeContentSize|assertSizeCeiling|exceedsNodeContentLimit)\(/g;

describe('#5019 every direct node write under src is classified at the size ceiling', () => {
  it('the table and the source agree, by file, write count and check count', () => {
    const found: Record<string, { n: number; checks: number }> = {};
    for (const p of walk('src')) {
      if (!p.endsWith('.ts') || p.endsWith('.test.ts') || isFixture(p)) continue;
      const src = readFileSync(p, 'utf8');
      const n = (src.match(DIRECT_WRITE) ?? []).length;
      if (n) found[p] = { n, checks: (src.match(SIZE_CALL) ?? []).length };
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(CONTENT_WRITES).map(([p, v]) => [p, { n: v.n, checks: v.checks }])));
    for (const [p, v] of Object.entries(CONTENT_WRITES)) expect(v.because.length, p).toBeGreaterThan(15);
  });
});
