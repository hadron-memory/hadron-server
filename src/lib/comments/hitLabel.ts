/**
 * #1608 (`cor:dmo:110:08`) — what agent retrieval says about a comment hit:
 * that it IS a comment (feedback), what it is about (target and anchor
 * revision), and who wrote it, so no agent reads it as a fact about the target.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { COMMENT_NODE_TYPE, parseAuthorKey } from './index.js';

export type CommentHitInfo = {
  targetLoc: string;
  targetMemoryId: string;
  targetRevision: number;
  anchorRevision: number;
  threadRootId: string | null;
  author: string;
  stub: 'retracted' | 'hidden' | null;
};

/** Per comment id among `ids`, the facts its hit label needs (one batch). */
export async function commentHitInfo(db: Pick<PrismaClient, 'commentMeta' | 'edge' | 'node' | 'worker' | 'user' | 'agent' | 'app'>, ids: string[]): Promise<Map<string, CommentHitInfo>> {
  if (ids.length === 0) return new Map();
  const metas = await db.commentMeta.findMany({
    where: { nodeId: { in: ids }, node: { nodeType: COMMENT_NODE_TYPE } },
    select: {
      nodeId: true, threadRootId: true, authorKey: true, retractedAt: true, hiddenAt: true,
      target: { select: { loc: true, memoryId: true, revSeq: true } },
    },
  });
  const anchors = await db.edge.findMany({
    where: { sourceId: { in: metas.map((m) => m.threadRootId ?? m.nodeId) }, governedKind: 'COMMENT_ANCHOR' },
    select: { sourceId: true, anchorRevNo: true },
  });
  const anchorOf = new Map(anchors.map((a) => [a.sourceId, a.anchorRevNo ?? 0]));
  const names = await authorNames(db, metas.map((m) => m.authorKey));
  return new Map(metas.map((m) => [m.nodeId, {
    targetLoc: m.target.loc,
    targetMemoryId: m.target.memoryId,
    targetRevision: m.target.revSeq,
    anchorRevision: anchorOf.get(m.threadRootId ?? m.nodeId) ?? 0,
    threadRootId: m.threadRootId,
    author: describeAuthor(m.authorKey, names),
    stub: m.hiddenAt ? 'hidden' : m.retractedAt ? 'retracted' : null,
  }]));
}

type Names = Map<string, string>;

/** Display names for the workers, users, agents and Apps behind `keys` (public identifiers only). */
async function authorNames(db: Pick<PrismaClient, 'worker' | 'user' | 'agent' | 'app'>, keys: string[]): Promise<Names> {
  const ids = { worker: new Set<string>(), user: new Set<string>(), agent: new Set<string>(), app: new Set<string>() };
  for (const key of keys) {
    const a = parseAuthorKey(key);
    if (a.kind === 'WORKER') ids.worker.add(a.workerId);
    if (a.kind === 'USER' || a.kind === 'USER_AGENT') ids.user.add(a.userId);
    if (a.kind === 'USER_AGENT') ids.agent.add(a.agentId);
    if (a.kind === 'APP') ids.app.add(a.appId);
  }
  const [workers, users, agents, apps] = await Promise.all([
    db.worker.findMany({ where: { id: { in: [...ids.worker] } }, select: { id: true, name: true } }),
    db.user.findMany({ where: { id: { in: [...ids.user] } }, select: { id: true, handle: true, name: true } }),
    db.agent.findMany({ where: { id: { in: [...ids.agent] } }, select: { id: true, name: true } }),
    db.app.findMany({ where: { id: { in: [...ids.app] } }, select: { id: true, name: true } }),
  ]);
  const names: Names = new Map();
  for (const w of workers) names.set(`worker:${w.id}`, w.name);
  for (const u of users) names.set(`user:${u.id}`, u.handle ? `@${u.handle}` : u.name ?? u.id);
  for (const a of agents) names.set(`agent:${a.id}`, a.name);
  for (const a of apps) names.set(`app:${a.id}`, a.name);
  return names;
}

/** A plain-text author description from an author key, with names where known. */
export function describeAuthor(authorKey: string, names: Names = new Map()): string {
  const a = parseAuthorKey(authorKey);
  const n = (kind: string, id: string) => names.get(`${kind}:${id}`) ?? id;
  switch (a.kind) {
    case 'WORKER': return `worker ${n('worker', a.workerId)}`;
    case 'USER_AGENT': return `user ${n('user', a.userId)} via agent ${n('agent', a.agentId)}`;
    case 'USER': return `user ${n('user', a.userId)}`;
    case 'APP': return `App ${n('app', a.appId)}`;
  }
}

/**
 * The label line an MCP/agent surface prints under a comment hit. It says what
 * the hit is before anything quotes it.
 */
export function commentHitLabel(info: CommentHitInfo, targetUrn: string): string {
  const revision = info.anchorRevision === info.targetRevision
    ? `the current revision ${info.anchorRevision}`
    : `revision ${info.anchorRevision} (the target is now at ${info.targetRevision})`;
  const stub = info.stub ? ` It is ${info.stub}; its text is withheld.` : '';
  return `  COMMENT: feedback by ${info.author} about ${targetUrn}, written against ${revision}. It is not content of that node and not verified fact.${stub}`;
}
