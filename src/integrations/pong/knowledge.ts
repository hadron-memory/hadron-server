/**
 * Pong knowledge documents are stored as nodes in the station's hadron memory,
 * not in a Pong-specific Postgres table. This module is the single source of
 * truth for the loc/tag conventions and the station→memory lookup.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { serializeTags, deserializeTags } from '../db/provider.js';
import { writeNodeToGit } from '../github/writeNodeToGit.js';

const NODE_TYPE = 'pong-knowledge';
const LOC_PREFIX = 'pong/knowledge/';
const DOCTYPE_TAG_PREFIX = 'doctype:';

export interface PongKnowledge {
  id: string;
  title: string;
  content: string;
  docType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface NodeRow {
  id: string;
  loc: string;
  name: string;
  content: string | null;
  tags: string[] | string;
  createdAt: Date;
  updatedAt: Date;
}

function nodeToPongKnowledge(node: NodeRow): PongKnowledge {
  const tags = deserializeTags(node.tags);
  const docTypeTag = tags.find((t) => t.startsWith(DOCTYPE_TAG_PREFIX));
  return {
    id: node.loc,
    title: node.name,
    content: node.content ?? '',
    docType: docTypeTag ? docTypeTag.slice(DOCTYPE_TAG_PREFIX.length) : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function buildTags(docType?: string | null): string[] {
  const tags = ['pong', 'knowledge'];
  if (docType) tags.push(`${DOCTYPE_TAG_PREFIX}${docType}`);
  return tags;
}

/**
 * Resolve the memory id, returning null when any link in the chain is missing.
 * Callers that need a hard guarantee (writes) should throw on null themselves.
 */
async function resolvePongMemoryIdOptional(
  db: PrismaClient,
  connectionId: string,
): Promise<string | null> {
  const connection = await db.exchangeConnection.findUnique({
    where: { id: connectionId },
    select: { pongStationId: true },
  });
  if (!connection?.pongStationId) return null;
  const sub = await db.stationAgentSubscription.findFirst({
    where: { stationId: connection.pongStationId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: {
      agent: {
        include: {
          memoryItems: { orderBy: { createdAt: 'asc' }, take: 1 },
        },
      },
    },
  });
  return sub?.agent.memoryItems[0]?.memoryId ?? null;
}

/**
 * Strict variant — throws a clear error when the memory chain is incomplete.
 * Used by write operations (add/update/delete) that cannot proceed without it.
 */
export async function resolvePongMemoryId(
  db: PrismaClient,
  connectionId: string,
): Promise<string> {
  const memoryId = await resolvePongMemoryIdOptional(db, connectionId);
  if (!memoryId) {
    throw new Error(
      'Pong is not linked to a station with memory. Pick a station and ensure it has an agent with at least one memory.',
    );
  }
  return memoryId;
}

export async function listPongKnowledge(
  db: PrismaClient,
  connectionId: string,
): Promise<PongKnowledge[]> {
  const memoryId = await resolvePongMemoryIdOptional(db, connectionId);
  if (!memoryId) return [];
  const nodes = await db.node.findMany({
    where: { memoryId, nodeType: NODE_TYPE, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      loc: true,
      name: true,
      content: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return nodes.map(nodeToPongKnowledge);
}

export async function findPongKnowledgeByTitleContains(
  db: PrismaClient,
  connectionId: string,
  needle: string,
): Promise<PongKnowledge | null> {
  const memoryId = await resolvePongMemoryIdOptional(db, connectionId);
  if (!memoryId) return null;
  const node = await db.node.findFirst({
    where: {
      memoryId,
      nodeType: NODE_TYPE,
      deletedAt: null,
      name: { contains: needle },
    },
    select: {
      id: true,
      loc: true,
      name: true,
      content: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return node ? nodeToPongKnowledge(node) : null;
}

export async function addPongKnowledge(
  db: PrismaClient,
  args: {
    connectionId: string;
    title: string;
    content: string;
    docType?: string | null;
    createdBy?: string | null;
  },
): Promise<PongKnowledge> {
  const memoryId = await resolvePongMemoryId(db, args.connectionId);
  const loc = `${LOC_PREFIX}${generateId()}`;
  const tags = buildTags(args.docType);

  const node = await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      nodeType: NODE_TYPE,
      loc,
      name: args.title.trim(),
      content: args.content,
      tags: serializeTags(tags) as string[],
      createdBy: args.createdBy ?? null,
    },
    select: {
      id: true,
      loc: true,
      name: true,
      content: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  writeNodeToGit(
    {
      id: node.id,
      loc: node.loc,
      name: node.name,
      alias: null,
      description: null,
      content: node.content,
      tags,
      outgoingEdges: [],
    },
    '',
    args.createdBy ?? undefined,
    memoryId,
  ).catch((err) => {
    console.error('[pong-knowledge] git write error:', err);
  });

  return nodeToPongKnowledge(node);
}

export async function updatePongKnowledge(
  db: PrismaClient,
  args: {
    connectionId: string;
    id: string;
    title?: string;
    content?: string;
    docType?: string | null;
    editedBy?: string | null;
  },
): Promise<PongKnowledge> {
  const memoryId = await resolvePongMemoryId(db, args.connectionId);
  const existing = await db.node.findUnique({
    where: { loc_memoryId: { loc: args.id, memoryId } },
    select: { id: true, name: true, content: true, tags: true, nodeType: true },
  });
  if (!existing || existing.nodeType !== NODE_TYPE) {
    throw new Error('Pong knowledge document not found');
  }

  const currentTags = deserializeTags(existing.tags);
  const currentDocType = currentTags
    .find((t) => t.startsWith(DOCTYPE_TAG_PREFIX))
    ?.slice(DOCTYPE_TAG_PREFIX.length) ?? null;
  const nextDocType = args.docType !== undefined ? args.docType : currentDocType;
  const nextTags = buildTags(nextDocType);
  const nextName = args.title !== undefined ? args.title.trim() : existing.name;
  const nextContent = args.content !== undefined ? args.content : existing.content;

  const node = await db.node.update({
    where: { loc_memoryId: { loc: args.id, memoryId } },
    data: {
      name: nextName,
      content: nextContent,
      tags: serializeTags(nextTags) as string[],
    },
    select: {
      id: true,
      loc: true,
      name: true,
      content: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  writeNodeToGit(
    {
      id: node.id,
      loc: node.loc,
      name: node.name,
      alias: null,
      description: null,
      content: node.content,
      tags: nextTags,
      outgoingEdges: [],
    },
    '',
    args.editedBy ?? undefined,
    memoryId,
  ).catch((err) => {
    console.error('[pong-knowledge] git write error:', err);
  });

  return nodeToPongKnowledge(node);
}

export async function deletePongKnowledge(
  db: PrismaClient,
  args: { connectionId: string; id: string },
): Promise<boolean> {
  const memoryId = await resolvePongMemoryId(db, args.connectionId);
  const existing = await db.node.findUnique({
    where: { loc_memoryId: { loc: args.id, memoryId } },
    select: { id: true, nodeType: true },
  });
  if (!existing || existing.nodeType !== NODE_TYPE) return false;
  await db.node.delete({
    where: { loc_memoryId: { loc: args.id, memoryId } },
  });
  return true;
}
