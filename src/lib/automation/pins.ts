/** #1719 R5b interim consent artifact. Replace this mechanism with signed
 * compiled automation; never remove the exact-automation execution gate. */
import { createHash } from 'node:crypto';
import type { PrismaClient, AppRun } from '../../generated/prisma/index.js';
import { canonicalizeAutomationJson } from './format.js';
import { canReadMemory } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import { NodeNotFoundError } from '../entityRef/errors.js';
import { resolveNodeRef } from '../entityRef/nodeRef.js';
import { emitNodeUrnV2 } from '../urnEmit.js';

export class AutomationPinError extends Error {
  constructor(readonly code: 'AUTOMATION_CHANGED' | 'AUTOMATION_UNADOPTED', changed: string) {
    super(`${changed}. Nothing further will execute; the run-as user must preview and re-adopt the automation.`);
  }
}
export interface AutomationPin {
  format: 'hadron-automation-pin-v1'; appId: string; userId: string | null;
  entry: string; entryId: string; hash: string;
  nodes: Record<string, { urn: string; hash: string; state: Record<string, unknown> }>;
  edges: Record<string, string>; missing: string[];
}
const hash = (value: unknown) => createHash('sha256').update(canonicalizeAutomationJson(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Load the complete graph, including every routing/dependency edge and
 * Mustache default-data, dot-reference and partial node. Bounds fail loudly. */
export async function captureAutomationPin(db: PrismaClient, appId: string, userId: string | null,
  entry: string, organizationId: string, principal?: AuthContext): Promise<AutomationPin> {
  const { id: entryId } = await resolveNodeRef(db, entry);
  const nodes: AutomationPin['nodes'] = {}; const edges: AutomationPin['edges'] = {};
  const missing = new Set<string>(); const pending = [entryId];
  while (pending.length) {
    const id = pending.pop()!;
    if (Object.hasOwn(nodes, id)) continue;
    if (Object.keys(nodes).length >= 200 || Object.keys(edges).length > 1000) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph exceeds 200 nodes or 1000 edges');
    }
    if (principal) {
      const anchor = await db.node.findUnique({ where: { id }, select: { memoryId: true } });
      if (!anchor || !await canReadMemory(db, principal, anchor.memoryId)) {
        throw new AutomationPinError('AUTOMATION_CHANGED', `Automation dependency ${id} is not readable by the run principal`);
      }
    }
    const node = await db.node.findUnique({ where: { id }, select: {
      id: true, memoryId: true, loc: true, name: true, content: true, description: true, abstract: true,
      data: true, properties: true, tags: true, seq: true, nodeType: true, role: true,
      objectType: true, isRunnable: true, revSeq: true, deletedAt: true,
      memory: { select: { urn: true, organizationId: true, class: true, userId: true,
        ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true } },
      outgoingEdges: { orderBy: { id: 'asc' } },
    } });
    if (!node || node.deletedAt || node.memory.deletedAt || node.memory.isEncrypted || node.memory.organizationId !== organizationId) {
      throw new AutomationPinError('AUTOMATION_CHANGED', `Automation node ${id} is missing, encrypted or outside its organization`);
    }
    const { outgoingEdges, ...state } = node;
    nodes[id] = { urn: emitNodeUrnV2(node.memory.urn, node.loc), hash: hash(json(state)), state: json(state) };
    // Include tombstones in the edge fingerprint: add/delete/revive must not
    // erase evidence of a post-adoption graph edit.
    for (const edge of outgoingEdges) {
      edges[edge.id] = hash(json(edge));
      if (!edge.deletedAt) pending.push(edge.targetId);
    }
    if (node.content?.includes('{{')) {
      const locs = new Set(['data']);
      for (const match of node.content.matchAll(/\{\{[#^/]?([a-zA-Z0-9_-]+)\./g)) locs.add(match[1]);
      for (const match of node.content.matchAll(/\{\{>\s*([^}]+)\s*\}\}/g)) locs.add(match[1].trim());
      for (const loc of locs) {
        const dependency = await db.node.findFirst({ where: { memoryId: node.memoryId, loc, deletedAt: null }, select: { id: true } });
        if (dependency) pending.push(dependency.id);
        else missing.add(`${node.memoryId}:${loc}`);
      }
    }
  }
  if (Object.keys(edges).length > 1000) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph exceeds 1000 edges');
  const value = { format: 'hadron-automation-pin-v1' as const, appId, userId, entry, entryId, nodes, edges, missing: [...missing].sort() };
  const result = { ...value, hash: hash(value) };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation pin exceeds 256 KiB');
  return result;
}

/** Keep D20's observable failed AppRun for unresolved setup, while never
 * turning a missing graph into execution consent or swallowing infrastructure errors. */
export async function captureSetupConsent(...args: Parameters<typeof captureAutomationPin>): Promise<unknown> {
  try { return await captureAutomationPin(...args); }
  catch (e) {
    if (e instanceof NodeNotFoundError || e instanceof AutomationPinError) {
      return { format: 'hadron-automation-unadopted-v1', message: (e as Error).message };
    }
    throw e;
  }
}

/** Invalid persisted consent is never treated as an absent optional gate. */
export function parseAutomationPin(raw: unknown): AutomationPin {
  if ((raw as { format?: string })?.format === 'hadron-automation-unadopted-v1') throw new AutomationPinError('AUTOMATION_UNADOPTED', `Setup could not be adopted: ${(raw as { message: string }).message}`);
  const p = raw as AutomationPin | null;
  if (!p || p.format !== 'hadron-automation-pin-v1' || !p.hash || !p.entry || !p.entryId ||
      !p.nodes || !p.edges || !Array.isArray(p.missing)) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation has no valid setup pin');
  const { hash: digest, ...state } = p;
  if (hash(state) !== digest) throw new AutomationPinError('AUTOMATION_CHANGED', 'Stored automation pin is corrupt');
  return p;
}

/** Validate the entire setup before any hop executes, and before each effect.
 * A resumed run retains its original consent even if its trigger re-adopts. */
export async function verifyAutomationPin(db: PrismaClient, run: AppRun, nodeUrn = run.entryNodeUrn): Promise<void> {
  const pin = parseAutomationPin(run.automationPin);
  if (pin.appId !== run.appId || pin.userId !== run.userId ||
      (['SCHEDULE', 'WEBHOOK', 'MANUAL'].includes(run.triggerKind) && pin.entry !== run.entryNodeUrn)) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation identity changed');
  let current: AutomationPin;
  try { current = await captureAutomationPin(db, run.appId, run.userId, pin.entry, run.organizationId, { appId: run.appId, userId: run.userId ?? undefined, clientId: `run:${run.id}`, organizationId: run.organizationId }); }
  catch (e) { throw new AutomationPinError('AUTOMATION_CHANGED', `Automation graph cannot be loaded: ${(e as Error).message}`); }
  if (current.hash !== pin.hash) {
    const changedNodes = [...new Set([...Object.keys(pin.nodes), ...Object.keys(current.nodes)])]
      .filter(id => pin.nodes[id]?.hash !== current.nodes[id]?.hash).map(id => pin.nodes[id]?.urn ?? current.nodes[id]?.urn);
    const changedEdges = [...new Set([...Object.keys(pin.edges), ...Object.keys(current.edges)])].filter(id => pin.edges[id] !== current.edges[id]);
    throw new AutomationPinError('AUTOMATION_CHANGED', `Automation changed: nodes [${changedNodes.join(', ')}], edges [${changedEdges.join(', ')}], template dependencies ${current.missing.join(', ')}`);
  }
  const { id } = await resolveNodeRef(db, nodeUrn);
  if (!Object.hasOwn(pin.nodes, id)) throw new AutomationPinError('AUTOMATION_CHANGED', `Child or routed flow ${nodeUrn} is outside the adopted graph`);
}

/** Poll events use their origin trigger's CURRENT consent, never the routing
 * binding as approval. Manual launches act as their own trigger. */
export async function currentOriginPin(db: PrismaClient, runId: string): Promise<unknown> {
  const seen = new Set<string>();
  for (let id: string | null = runId; id;) {
    if (seen.has(id) || seen.size >= 100) throw new AutomationPinError('AUTOMATION_CHANGED', 'Origin-run lineage is invalid');
    seen.add(id);
    const run: AppRun | null = await db.appRun.findUnique({ where: { id } });
    if (!run) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Origin run is missing');
    if (run.triggerKind === 'SCHEDULE') return (await db.agentSchedule.findFirst({ where: { id: run.triggerId ?? '', deletedAt: null } }))?.automationPin;
    if (run.triggerKind === 'WEBHOOK') return (await db.agentWebhook.findFirst({ where: { id: run.triggerId ?? '', deletedAt: null } }))?.automationPin;
    if (run.triggerKind === 'MANUAL') return (await db.manualAutomationPin.findUnique({ where: { runId: run.id } }))?.pin;
    id = run.parentRunId;
  }
  throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Origin trigger is missing');
}
