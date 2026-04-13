/**
 * Pong settings live as a single node in the station's hadron memory at the
 * fixed loc "pong/settings". The actual settings are serialized as JSON in the
 * node's content. The bootstrap pointer (which station, therefore which
 * memory) lives on ExchangeConnection.pongStationId.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { serializeTags } from '../db/provider.js';
import { writeNodeToGit } from '../github/writeNodeToGit.js';

const NODE_TYPE = 'pong-settings';
const SETTINGS_LOC = 'pong/settings';
const SETTINGS_NAME = 'Pong Settings';
const TAGS = ['pong', 'settings'];

export interface PongExclusionRule {
  senderPattern?: string | null;
  subjectPattern?: string | null;
  reason?: string | null;
}

export interface PongSettings {
  id: string;
  exchangeConnectionId: string;
  userId: string;
  autoSendEnabled: boolean;
  confidenceThreshold: number;
  replyTone: string | null;
  signatureText: string | null;
  stationId: string | null;
  pausedUntil: Date | null;
  exclusionRules: PongExclusionRule[];
  allowMcpSend: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface SettingsBlob {
  autoSendEnabled?: boolean;
  confidenceThreshold?: number;
  replyTone?: string | null;
  signatureText?: string | null;
  pausedUntil?: string | null;
  exclusionRules?: PongExclusionRule[];
  allowMcpSend?: boolean;
}

const DEFAULT_BLOB: Required<Omit<SettingsBlob, 'replyTone' | 'signatureText' | 'pausedUntil'>> & {
  replyTone: string | null;
  signatureText: string | null;
  pausedUntil: string | null;
} = {
  autoSendEnabled: false,
  confidenceThreshold: 0.95,
  replyTone: null,
  signatureText: null,
  pausedUntil: null,
  exclusionRules: [],
  allowMcpSend: false,
};

function parseBlob(content: string | null): SettingsBlob {
  if (!content) return {};
  try {
    return JSON.parse(content) as SettingsBlob;
  } catch {
    return {};
  }
}

function blobToSettings(
  blob: SettingsBlob,
  ctx: {
    connectionId: string;
    userId: string;
    stationId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
): PongSettings {
  return {
    id: ctx.connectionId,
    exchangeConnectionId: ctx.connectionId,
    userId: ctx.userId,
    autoSendEnabled: blob.autoSendEnabled ?? DEFAULT_BLOB.autoSendEnabled,
    confidenceThreshold: blob.confidenceThreshold ?? DEFAULT_BLOB.confidenceThreshold,
    replyTone: blob.replyTone ?? null,
    signatureText: blob.signatureText ?? null,
    stationId: ctx.stationId,
    pausedUntil: blob.pausedUntil ? new Date(blob.pausedUntil) : null,
    exclusionRules: blob.exclusionRules ?? [],
    allowMcpSend: blob.allowMcpSend ?? DEFAULT_BLOB.allowMcpSend,
    createdAt: ctx.createdAt,
    updatedAt: ctx.updatedAt,
  };
}

interface ConnectionInfo {
  id: string;
  userId: string;
  pongStationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

async function loadConnection(db: PrismaClient, connectionId: string): Promise<ConnectionInfo> {
  const conn = await db.exchangeConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { id: true, userId: true, pongStationId: true, createdAt: true, updatedAt: true },
  });
  return conn;
}

async function resolveSettingsMemoryId(
  db: PrismaClient,
  pongStationId: string | null,
): Promise<string | null> {
  if (!pongStationId) return null;
  const sub = await db.stationAgentSubscription.findFirst({
    where: { stationId: pongStationId, deletedAt: null },
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

async function readSettingsBlob(
  db: PrismaClient,
  memoryId: string,
): Promise<{ blob: SettingsBlob; nodeUpdatedAt: Date | null }> {
  const node = await db.node.findUnique({
    where: { loc_memoryId: { loc: SETTINGS_LOC, memoryId } },
    select: { content: true, updatedAt: true },
  });
  if (!node) return { blob: {}, nodeUpdatedAt: null };
  return { blob: parseBlob(node.content), nodeUpdatedAt: node.updatedAt };
}

async function writeSettingsBlob(
  db: PrismaClient,
  memoryId: string,
  blob: SettingsBlob,
  editedBy: string | null,
): Promise<Date> {
  const content = JSON.stringify(blob, null, 2);
  const node = await db.node.upsert({
    where: { loc_memoryId: { loc: SETTINGS_LOC, memoryId } },
    create: {
      id: generateId(),
      memoryId,
      nodeType: NODE_TYPE,
      loc: SETTINGS_LOC,
      name: SETTINGS_NAME,
      content,
      tags: serializeTags(TAGS) as string[],
      createdBy: editedBy,
    },
    update: {
      content,
      tags: serializeTags(TAGS) as string[],
    },
    select: { id: true, loc: true, name: true, content: true, updatedAt: true },
  });

  writeNodeToGit(
    {
      id: node.id,
      loc: node.loc,
      name: node.name,
      alias: null,
      description: null,
      content: node.content,
      tags: TAGS,
      outgoingEdges: [],
    },
    '',
    editedBy ?? undefined,
    memoryId,
  ).catch((err) => {
    console.error('[pong-settings] git write error:', err);
  });

  return node.updatedAt;
}

/** Read settings for a connection. Returns defaults when no station is linked
 *  or no settings node exists yet. Never throws on the "not configured yet" path. */
export async function getPongSettings(
  db: PrismaClient,
  connectionId: string,
): Promise<PongSettings | null> {
  const conn = await loadConnection(db, connectionId);
  if (!conn.pongStationId) {
    return blobToSettings({}, {
      connectionId: conn.id,
      userId: conn.userId,
      stationId: null,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    });
  }
  const memoryId = await resolveSettingsMemoryId(db, conn.pongStationId);
  if (!memoryId) {
    return blobToSettings({}, {
      connectionId: conn.id,
      userId: conn.userId,
      stationId: conn.pongStationId,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    });
  }
  const { blob, nodeUpdatedAt } = await readSettingsBlob(db, memoryId);
  return blobToSettings(blob, {
    connectionId: conn.id,
    userId: conn.userId,
    stationId: conn.pongStationId,
    createdAt: conn.createdAt,
    updatedAt: nodeUpdatedAt ?? conn.updatedAt,
  });
}

export interface UpsertSettingsInput {
  autoSendEnabled?: boolean;
  confidenceThreshold?: number;
  replyTone?: string | null;
  signatureText?: string | null;
  stationId?: string | null;
  pausedUntil?: string | null;
  exclusionRules?: PongExclusionRule[];
  allowMcpSend?: boolean;
}

/**
 * Update settings for a connection. If `stationId` is provided, the bootstrap
 * pointer on ExchangeConnection is updated first, which may unlock memory
 * writes for the rest of the fields.
 */
export async function upsertPongSettings(
  db: PrismaClient,
  connectionId: string,
  input: UpsertSettingsInput,
  editedBy: string | null,
): Promise<PongSettings> {
  let conn = await loadConnection(db, connectionId);

  if (input.stationId !== undefined) {
    await db.exchangeConnection.update({
      where: { id: connectionId },
      data: { pongStationId: input.stationId ?? null },
    });
    conn = { ...conn, pongStationId: input.stationId ?? null };
  }

  const memoryFieldsProvided =
    input.autoSendEnabled !== undefined ||
    input.confidenceThreshold !== undefined ||
    input.replyTone !== undefined ||
    input.signatureText !== undefined ||
    input.pausedUntil !== undefined ||
    input.exclusionRules !== undefined ||
    input.allowMcpSend !== undefined;

  if (!memoryFieldsProvided) {
    return getPongSettings(db, connectionId) as Promise<PongSettings>;
  }

  if (!conn.pongStationId) {
    throw new Error('Pong is not linked to a station. Set stationId first.');
  }
  const memoryId = await resolveSettingsMemoryId(db, conn.pongStationId);
  if (!memoryId) {
    throw new Error('The linked station has no memory subscription.');
  }

  const { blob: existing } = await readSettingsBlob(db, memoryId);
  const next: SettingsBlob = {
    ...existing,
    ...(input.autoSendEnabled !== undefined && { autoSendEnabled: input.autoSendEnabled }),
    ...(input.confidenceThreshold !== undefined && { confidenceThreshold: input.confidenceThreshold }),
    ...(input.replyTone !== undefined && { replyTone: input.replyTone }),
    ...(input.signatureText !== undefined && { signatureText: input.signatureText }),
    ...(input.pausedUntil !== undefined && { pausedUntil: input.pausedUntil }),
    ...(input.exclusionRules !== undefined && { exclusionRules: input.exclusionRules }),
    ...(input.allowMcpSend !== undefined && { allowMcpSend: input.allowMcpSend }),
  };
  const updatedAt = await writeSettingsBlob(db, memoryId, next, editedBy);

  return blobToSettings(next, {
    connectionId: conn.id,
    userId: conn.userId,
    stationId: conn.pongStationId,
    createdAt: conn.createdAt,
    updatedAt,
  });
}

export async function pausePong(
  db: PrismaClient,
  connectionId: string,
  until: string | null,
  editedBy: string | null,
): Promise<PongSettings> {
  return upsertPongSettings(db, connectionId, { pausedUntil: until }, editedBy);
}

export async function resumePong(
  db: PrismaClient,
  connectionId: string,
  editedBy: string | null,
): Promise<PongSettings> {
  return upsertPongSettings(db, connectionId, { pausedUntil: null }, editedBy);
}

export async function addPongExclusionRule(
  db: PrismaClient,
  connectionId: string,
  rule: PongExclusionRule,
  editedBy: string | null,
): Promise<PongSettings> {
  const current = await getPongSettings(db, connectionId);
  const rules = current?.exclusionRules ?? [];
  return upsertPongSettings(
    db,
    connectionId,
    { exclusionRules: [...rules, rule] },
    editedBy,
  );
}

export async function removePongExclusionRule(
  db: PrismaClient,
  connectionId: string,
  index: number,
  editedBy: string | null,
): Promise<PongSettings> {
  const current = await getPongSettings(db, connectionId);
  const rules = current?.exclusionRules ?? [];
  if (index < 0 || index >= rules.length) {
    throw new Error('Exclusion rule index out of range');
  }
  return upsertPongSettings(
    db,
    connectionId,
    { exclusionRules: rules.filter((_r, i) => i !== index) },
    editedBy,
  );
}
