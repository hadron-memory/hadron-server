/**
 * #4034 (plan D2/D3, rulings Q9/Q10; cor:cht:020:01 "Pinning to a published version", cor:cht:030:02):
 * the ONE reader a chat turn takes its script from, answering from the revision the chat is pinned to
 * or from the live draft, chosen once when the reader is built.
 *
 * What "script" covers: the conversation, stage and prompt nodes; each stage's outgoing rules (edges with
 * condition, priority, timing and behaviour); the conversation and agent-level extraction spec; the
 * agent-wide condition defaults (the system memory's `data` node and the stage's ancestors); `agent.config`.
 * It is built per call (per turn), from `(systemMemoryId, revisionLoc)`, and reads only that Agent's own
 * system memory by the id the caller already resolved behind its turn gate: it is not a new door.
 *
 * Three sources, fixed at construction:
 * - `live`: no revision (a never-published Agent, or a pinned revision node that no longer exists). Every
 *   read hits the draft, exactly as before.
 * - `snapshot`: a v2 snapshot (`edgeFormat: 2`). Everything above is read from the snapshot.
 * - `snapshot-pre-v2`: a snapshot taken before D3. It holds no edge `condition`/`priority` and no node
 *   `seq`, so a naive read would fire every conditional rule unconditionally. Per ruling Q9 its rules and
 *   the conversation `seq` are read LIVE until the author republishes; nodes still come from the snapshot,
 *   and the reader logs `chat_script_pre_v2_live_rules` once per turn (one reader, one log).
 *
 * Stays live by ruling Q10: the memory-wide-field list (`declaredMemoryWideFields`), read inside the
 * condition layer. A pin states it.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { buildPrismaMemoryLayer } from './edge-conditions/prisma-memory-layer.js';
import type { MemoryLayerHandle } from './edge-conditions/scope-resolver.js';

/** The snapshot format that carries edge `condition`/`priority` and node `seq` (plan D3). */
export const CHAT_SCRIPT_EDGE_FORMAT = 2;

export interface ScriptNode {
  loc: string;
  name: string;
  nodeType?: string;
  description?: string | null;
  content?: string | null;
  data?: unknown;
  /** Sibling sort order. Read live for a pre-v2 snapshot (Q9). */
  seq?: number | null;
}

export interface ScriptRule {
  /** The edge id when live; a stable `<edge loc>` (else `<source>-><target>`) when read from a snapshot. */
  id: string;
  condition: unknown;
  priority: number;
  /** The edge's `data` bag: `timing`, `behavior`, `label`. */
  data: Record<string, unknown>;
  targetLoc: string;
}

export type ChatScriptSource = 'live' | 'snapshot' | 'snapshot-pre-v2';

export interface ChatScript {
  readonly source: ChatScriptSource;
  readonly systemMemoryId: string;
  node(loc: string): Promise<ScriptNode | null>;
  nodesByPrefix(prefix: string): Promise<ScriptNode[]>;
  /**
   * Outgoing rules of a stage, `priority` ascending. Ties keep today's `createdAt` order on a live read and
   * the snapshot's array order on a snapshot read (the snapshot is written in createdAt order of the node set,
   * and edges in the database's return order: the stable stand-in for the tiebreak).
   */
  outgoingRules(stageLoc: string): Promise<ScriptRule[]>;
  agentConfig(): Promise<Record<string, unknown>>;
  /** Layer A of the condition cascade: the system memory's `data` node and the stage's ancestors. */
  conditionLayerA(layerName: string, stageLoc: string, personId: string | null): Promise<MemoryLayerHandle>;
  /** True when this script's own nodes come from a snapshot, so a live home layer must always be added. */
  readonly pinned: boolean;
}

interface SnapshotShape {
  edgeFormat?: number;
  nodes?: ScriptNode[];
  edges?: Array<{
    sourceLoc: string; targetLoc: string; loc?: string; data?: unknown; condition?: unknown; priority?: number;
  }>;
}

const NODE_SELECT = {
  loc: true, name: true, nodeType: true, description: true, content: true, data: true, seq: true,
} as const;

export async function loadChatScript(
  db: PrismaClient,
  systemMemoryId: string,
  revisionLoc: string | null,
): Promise<ChatScript> {
  let snapshot: SnapshotShape | null = null;
  if (revisionLoc) {
    const revNode = await db.node.findFirst({
      where: { memoryId: systemMemoryId, loc: revisionLoc, deletedAt: null },
      select: { data: true },
    });
    const snap = ((revNode?.data as Record<string, unknown> | null)?.snapshot ?? null) as SnapshotShape | null;
    if (snap?.nodes) snapshot = snap;
  }

  const source: ChatScriptSource = !snapshot
    ? 'live'
    : snapshot.edgeFormat === CHAT_SCRIPT_EDGE_FORMAT ? 'snapshot' : 'snapshot-pre-v2';
  const nodesByLoc = new Map<string, ScriptNode>();
  for (const n of snapshot?.nodes ?? []) nodesByLoc.set(n.loc, n);

  let loggedLive = false;
  const noteLive = () => {
    if (loggedLive) return;
    loggedLive = true;
    console.warn(JSON.stringify({
      event: 'chat_script_pre_v2_live_rules', systemMemoryId, revisionLoc,
      note: 'pinned snapshot predates edgeFormat 2: rules and conversation seq are read live until republished',
    }));
  };

  const liveNodesByPrefix = async (prefix: string): Promise<ScriptNode[]> =>
    (await db.node.findMany({
      where: { memoryId: systemMemoryId, loc: { startsWith: prefix }, deletedAt: null },
      select: NODE_SELECT,
    })) as ScriptNode[];

  const liveRules = async (stageLoc: string): Promise<ScriptRule[]> => {
    const stage = await db.node.findFirst({
      where: { memoryId: systemMemoryId, loc: stageLoc, deletedAt: null },
      select: { id: true },
    });
    if (!stage) return [];
    const edges = await db.edge.findMany({
      where: { sourceId: stage.id, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: { target: { select: { loc: true } } },
    });
    return edges.flatMap((e) => e.target?.loc ? [{
      id: e.id, condition: e.condition ?? null, priority: e.priority,
      data: (e.data as Record<string, unknown> | null) ?? {}, targetLoc: e.target.loc,
    }] : []);
  };

  const readNode = async (loc: string): Promise<ScriptNode | null> => {
    if (!snapshot) {
      return (await db.node.findFirst({
        where: { memoryId: systemMemoryId, loc, deletedAt: null }, select: NODE_SELECT,
      })) as ScriptNode | null;
    }
    return nodesByLoc.get(loc) ?? null;
  };

  return {
    source,
    systemMemoryId,
    pinned: !!snapshot,

    node: readNode,

    async nodesByPrefix(prefix) {
      if (!snapshot) return liveNodesByPrefix(prefix);
      const fromSnapshot = (snapshot.nodes ?? []).filter((n) => n.loc.startsWith(prefix));
      if (source !== 'snapshot-pre-v2') return fromSnapshot;
      // Q9: a pre-v2 snapshot holds no `seq`; the order is read live, by loc, for the nodes it lists.
      noteLive();
      const live = new Map((await liveNodesByPrefix(prefix)).map((n) => [n.loc, n.seq ?? null]));
      return fromSnapshot.map((n) => ({ ...n, seq: live.get(n.loc) ?? null }));
    },

    async outgoingRules(stageLoc) {
      if (!snapshot) return liveRules(stageLoc);
      if (source === 'snapshot-pre-v2') {
        noteLive();
        return liveRules(stageLoc);
      }
      return (snapshot.edges ?? [])
        .filter((e) => e.sourceLoc === stageLoc)
        .map((e, index) => ({ e, index }))
        .sort((a, b) => ((a.e.priority ?? 0) - (b.e.priority ?? 0)) || a.index - b.index)
        .map(({ e }) => ({
          id: e.loc ?? `${e.sourceLoc}->${e.targetLoc}`,
          condition: e.condition ?? null,
          priority: e.priority ?? 0,
          data: (e.data as Record<string, unknown> | null) ?? {},
          targetLoc: e.targetLoc,
        }));
    },

    async agentConfig() {
      const config = await readNode('config');
      return (config?.data as Record<string, unknown> | null) ?? {};
    },

    async conditionLayerA(layerName, stageLoc, personId) {
      if (!snapshot) {
        return buildPrismaMemoryLayer(db, layerName, systemMemoryId, stageLoc, personId);
      }
      const preloaded = ['data', ...stageLoc.split(':').map((_, i, parts) => parts.slice(0, i + 1).join(':'))]
        .flatMap((loc) => {
          const n = nodesByLoc.get(loc);
          return n ? [{ loc, data: n.data ?? null }] : [];
        });
      return buildPrismaMemoryLayer(db, layerName, systemMemoryId, stageLoc, personId, preloaded);
    },
  };
}
