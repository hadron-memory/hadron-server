/** #1719 R5b interim consent artifact. Replace this mechanism with signed
 * compiled automation; never remove the exact-automation execution gate. */
import { isRoutingName, routingNameOf } from '../runner/selectNextEdge.js';
import { executionIdentities, configSelection, aiIdentity, mcpIdentity, haIdentity, type ExecutionSelection, type ExecutionIdentities } from './identities.js';
import { createHash } from 'node:crypto';
import type { PrismaClient, AppRun } from '../../generated/prisma/index.js';
import { canonicalizeAutomationJson } from './format.js';
import { runAuthContext } from '../auth/runPrincipal.js';
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
  format: 'hadron-automation-pin-v2'; appId: string; userId: string | null;
  entry: string; entryId: string; hash: string;
  nodes: Record<string, { urn: string; hash: string }>;
  edges: Record<string, string>; resources: ExecutionIdentities;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalizeAutomationJson(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Capture flow definitions and their routing closure. Documents, template
 * inputs and output destinations remain mutable, read-gated data (#7894). */
export interface AutomationPreview extends AutomationPin {
  nodes: Record<string, { urn: string; hash: string; state: Record<string, unknown> }>;
}
/** Persist only consent identities and digests. Preview bytes never leave the response. */
export function storedAutomationPin(preview: AutomationPin): AutomationPin {
  const { hash: _, nodes, ...base } = preview;
  const value = { ...base, nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { urn: node.urn, hash: node.hash }])) };
  return { ...value, hash: hash(value) };
}
export async function captureAutomationPin(db: PrismaClient, appId: string, userId: string | null,
  entry: string, organizationId: string, principal: AuthContext, selection: ExecutionSelection = {}): Promise<AutomationPreview> {
  const { id: entryId } = await resolveNodeRef(db, entry);
  const nodes: AutomationPreview['nodes'] = {}; const edges: AutomationPin['edges'] = {};
  const pending = [entryId];
  while (pending.length) {
    const id = pending.pop()!;
    if (Object.hasOwn(nodes, id)) continue;
    if (Object.keys(nodes).length >= 200 || Object.keys(edges).length > 1000) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph exceeds 200 nodes or 1000 edges');
    }
    const anchor = await db.node.findUnique({ where: { id }, select: { memoryId: true } });
    if (!anchor || !await canReadMemory(db, principal, anchor.memoryId)) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation definition is not readable by its principal');
    }
    const node = await db.node.findUnique({ where: { id }, select: {
      id: true, memoryId: true, loc: true, name: true, content: true, description: true, abstract: true,
      data: true, properties: true, tags: true, seq: true, nodeType: true, role: true,
      objectType: true, isRunnable: true, revSeq: true, updatedAt: true, deletedAt: true,
      memory: { select: { urn: true, organizationId: true, class: true, userId: true,
        ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true } },
      outgoingEdges: { orderBy: { id: 'asc' } },
    } });
    if (!node || node.deletedAt || node.memory.deletedAt || node.memory.isEncrypted || node.memory.organizationId !== organizationId) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph contains a missing, encrypted or out-of-scope node');
    }
    // Only routing targets become definitions; reference documents and
    // template inputs are mutable data, authorized at their read boundary.
    const { outgoingEdges, ...state } = node;
    const { updatedAt: _, ...authored } = state;
    nodes[id] = { urn: emitNodeUrnV2(node.memory.urn, node.loc), hash: hash(json(authored)), state: json(state) };
    // Include tombstones in the edge fingerprint: add/delete/revive must not
    // erase evidence of a post-adoption graph edit.
    for (const edge of outgoingEdges) {
      edges[edge.id] = hash(json(edge));
      if (!edge.deletedAt && isRoutingName(routingNameOf(edge, node.loc))) pending.push(edge.targetId);
    }
  }
  if (Object.keys(edges).length > 1000) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph exceeds 1000 edges');
  const tools = Object.values(nodes).flatMap(node => { const data = node.state.data as { tools?: unknown } | null; return Array.isArray(data?.tools) ? data.tools.filter((name): name is string => typeof name === 'string') : []; });
  const resources = await executionIdentities(db, appId, organizationId, tools, selection);
  const value = { resources, format: 'hadron-automation-pin-v2' as const, appId, userId, entry, entryId, nodes, edges };
  const result = { ...value, hash: storedAutomationPin({ ...value, hash: '' }).hash };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation pin exceeds 256 KiB');
  return result;
}

/** Keep D20's observable failed AppRun for unresolved setup, while never
 * turning a missing graph into execution consent or swallowing infrastructure errors. */
export async function captureSetupConsent(...args: Parameters<typeof captureAutomationPin>): Promise<unknown> {
  try {
    const preview = await captureAutomationPin(...args);
    const [db, appId, userId, , organizationId] = args;
    // Consent needs both the creator's reach and the actual execution principal's reach.
    const principal = runAuthContext({ id: 'setup', appId, userId, organizationId });
    for (const node of Object.values(preview.nodes)) {
      if (!await canReadMemory(db, principal, String(node.state.memoryId))) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation definition is not readable by its run principal');
    }
    return storedAutomationPin(preview);
  }
  catch (e) {
    if (e instanceof NodeNotFoundError || e instanceof AutomationPinError) {
      return { format: 'hadron-automation-unadopted-v1', message: 'Setup graph is missing, unreadable, encrypted or exceeds the consent bounds' };
    }
    throw e;
  }
}

/** Invalid persisted consent is never treated as an absent optional gate. */
export function parseAutomationPin(raw: unknown): AutomationPin {
  if ((raw as { format?: string })?.format === 'hadron-automation-unadopted-v1') throw new AutomationPinError('AUTOMATION_UNADOPTED', `Setup could not be adopted: ${(raw as { message: string }).message}`);
  const p = raw as AutomationPin | null;
  if (!p || p.format !== 'hadron-automation-pin-v2' || !p.hash || !p.entry || !p.entryId ||
      !p.nodes || !p.edges || !p.resources || !p.resources.mcp || !p.resources.ha || !Array.isArray(p.resources.tools)) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation has no valid setup pin');
  if (Object.values(p.nodes).some(node => !node || typeof node.urn !== 'string' || typeof node.hash !== 'string' || Object.keys(node).some(key => !['urn', 'hash'].includes(key)))) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation pin contains unsupported node data');
  const { hash: digest, ...state } = p;
  if (hash(state) !== digest) throw new AutomationPinError('AUTOMATION_CHANGED', 'Stored automation pin is corrupt');
  return p;
}

/** Validate the entire setup before any hop executes, and before each effect.
 * A resumed run retains its original consent even if its trigger re-adopts. */
export async function verifyAutomationPin(db: PrismaClient, run: AppRun, nodeUrn = run.entryNodeUrn): Promise<AutomationPreview> {
  const pin = parseAutomationPin(run.automationPin);
  if (pin.appId !== run.appId || pin.userId !== run.userId ||
      (['SCHEDULE', 'WEBHOOK', 'MANUAL'].includes(run.triggerKind) && pin.entry !== run.entryNodeUrn)) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation identity changed');
  let current: AutomationPreview;
  try { current = await captureAutomationPin(db, run.appId, run.userId, pin.entry, run.organizationId, runAuthContext(run), configSelection(run)); }
  catch (e) { if (!(e instanceof AutomationPinError || e instanceof NodeNotFoundError)) throw e; throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph is no longer available or readable'); }
  if (current.hash !== pin.hash) {
    const changedNodes = [...new Set([...Object.keys(pin.nodes), ...Object.keys(current.nodes)])]
      .filter(id => pin.nodes[id]?.hash !== current.nodes[id]?.hash).map(id => pin.nodes[id]?.urn ?? current.nodes[id]?.urn);
    const changedEdges = [...new Set([...Object.keys(pin.edges), ...Object.keys(current.edges)])].filter(id => pin.edges[id] !== current.edges[id]);
    const identities = [];
    if (hash(pin.resources.ai) !== hash(current.resources.ai)) identities.push('AI configuration');
    if (hash(pin.resources.mcp) !== hash(current.resources.mcp)) identities.push('MCP registration');
    if (hash(pin.resources.ha) !== hash(current.resources.ha)) identities.push('Home Assistant registration');
    throw new AutomationPinError('AUTOMATION_CHANGED', `Automation changed: ${changedNodes.length} node(s), ${changedEdges.length} edge(s)${identities.length ? ', ' + identities.join(', ') + ' identity' : ''}`);
  }
  const { id } = await resolveNodeRef(db, nodeUrn);
  if (!Object.hasOwn(pin.nodes, id)) throw new AutomationPinError('AUTOMATION_CHANGED', 'Child or routed flow is outside the adopted graph');
  return current;
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

/** A hop's transient proof. Read only revision/authority metadata before effects:
 * no content, template rendering, routing recursion, or per-node queries.
 * Edges are small and hashed because writes need not bump the source revision. */
export async function checkAutomationRevisions(db: PrismaClient, run: AppRun, proof: AutomationPreview): Promise<void> {
  const rows = await db.node.findMany({ where: { id: { in: Object.keys(proof.nodes) } }, select: {
    id: true, memoryId: true, loc: true, revSeq: true, updatedAt: true, deletedAt: true,
    memory: { select: { urn: true, organizationId: true, class: true, userId: true, ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true } },
    outgoingEdges: { orderBy: { id: 'asc' } },
  } });
  const metadata = (state: Record<string, unknown>) => ({ id: state.id, memoryId: state.memoryId, loc: state.loc,
    revSeq: state.revSeq, updatedAt: state.updatedAt, deletedAt: state.deletedAt, memory: state.memory });
  const changed = new AutomationPinError('AUTOMATION_CHANGED', 'Automation revision, dependency edges or read authority changed during the hop');
  if (rows.length !== Object.keys(proof.nodes).length) throw changed;
  const edges: Record<string, string> = {};
  for (const row of rows) {
    if (hash(json(metadata(row))) !== hash(metadata(proof.nodes[row.id].state))) throw changed;
    for (const edge of row.outgoingEdges) edges[edge.id] = hash(json(edge));
  }
  if (hash(edges) !== hash(proof.edges)) throw changed;
  const principal = runAuthContext(run);
  for (const memoryId of new Set(rows.map(row => row.memoryId))) if (!await canReadMemory(db, principal, memoryId)) throw changed;
  const resources = await executionIdentities(db, run.appId, run.organizationId, proof.resources.tools, configSelection(run));
  if (hash(resources) !== hash(proof.resources)) throw new AutomationPinError('AUTOMATION_CHANGED', 'AI configuration or external tool registration changed during the hop');

}

/** Verify the exact row about to be used, not just a previous registry read. */
export function assertPinnedAiIdentity(run: AppRun, config: Parameters<typeof aiIdentity>[0]): void {
  if (hash(aiIdentity(config)) !== hash(parseAutomationPin(run.automationPin).resources.ai)) throw new AutomationPinError('AUTOMATION_CHANGED', 'Resolved AI configuration identity changed');
}
export function assertPinnedToolIdentity(run: AppRun, kind: 'mcp' | 'ha', slug: string,
  row: Parameters<typeof mcpIdentity>[0] | Parameters<typeof haIdentity>[0]): void {
  const expected = parseAutomationPin(run.automationPin).resources[kind][slug];
  const actual = kind === 'mcp' ? mcpIdentity(row as Parameters<typeof mcpIdentity>[0]) : haIdentity(row as Parameters<typeof haIdentity>[0]);
  if (!expected || hash(actual) !== hash(expected)) throw new AutomationPinError('AUTOMATION_CHANGED', 'Loaded external tool registration identity changed');
}
