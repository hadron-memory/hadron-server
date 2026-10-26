/** #1719 R5b interim consent artifact. Replace this mechanism with signed
 * compiled automation; never remove the exact-automation execution gate. */
import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import { storedIncludeTags } from '../includes/writeIncludes.js';
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
  constructor(readonly code: 'AUTOMATION_CHANGED' | 'AUTOMATION_UNADOPTED', changed: string, readonly reason?: 'MEMORY_UNREADABLE') {
    super(`${changed}. Nothing further will execute; the run-as user must preview and re-adopt the automation.`);
  }
}
export interface AutomationPin {
  format: 'hadron-automation-pin-v3'; appId: string; userId: string | null;
  entry: string; entryId: string; hash: string;
  nodes: Record<string, { urn: string; hash: string }>;
  edges: Record<string, string>; resources: ExecutionIdentities;
  flows: string[]; absentPartials: Array<{ urn: string; memoryId: string; loc: string }>;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalizeAutomationJson(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

const DEFINITION_SELECT = {
  id: true, memoryId: true, loc: true, name: true, content: true, description: true, abstract: true,
  data: true, properties: true, tags: true, seq: true, nodeType: true, role: true,
  objectType: true, isRunnable: true, revSeq: true, updatedAt: true, deletedAt: true,
  memory: { select: { urn: true, organizationId: true, class: true, userId: true,
    ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true } },
} as const;
const definitionHash = (state: Record<string, unknown>) => {
  const { updatedAt: _, ...authored } = state;
  return hash(json(authored));
};

/** Capture routed flow definitions and instruction partials. Documents, data
 * references and output destinations remain mutable, read-gated data (#7894). */
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
  const flows = new Set<string>(); const processedFlows = new Set<string>();
  const absentPartials = new Map<string, { urn: string; memoryId: string; loc: string }>();
  const partialRefs = new Set<string>();
  const pending = [{ id: entryId, flow: true }];
  while (pending.length) {
    const { id, flow } = pending.pop()!;
    if (flow) flows.add(id);
    if (Object.hasOwn(nodes, id) && (!flow || processedFlows.has(id))) continue;
    if ((Object.keys(nodes).length >= 200 && !Object.hasOwn(nodes, id)) || Object.keys(edges).length > 1000) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph exceeds 200 nodes or 1000 edges');
    }
    const anchor = await db.node.findUnique({ where: { id }, select: { memoryId: true } });
    if (!anchor || !await canReadMemory(db, principal, anchor.memoryId)) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation definition is not readable by its principal', 'MEMORY_UNREADABLE');
    }
    const node = await db.node.findUnique({ where: { id }, select: { ...DEFINITION_SELECT, outgoingEdges: { orderBy: { id: 'asc' } } } });
    if (!node || node.deletedAt || node.memory.deletedAt || node.memory.isEncrypted || node.memory.organizationId !== organizationId) {
      throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph contains a missing, encrypted or out-of-scope node');
    }
    // Routing targets and instruction partials are definitions; document
    // and dot-reference inputs are mutable data, authorized at their read boundary.
    const { outgoingEdges, ...state } = node;
    nodes[id] = { urn: emitNodeUrnV2(node.memory.urn, node.loc), hash: definitionHash(state), state: json(state) };
    // Include tombstones in the edge fingerprint: add/delete/revive must not
    // erase evidence of a post-adoption graph edit.
    if (flow) {
      processedFlows.add(id);
      for (const edge of outgoingEdges) {
        edges[edge.id] = hash(json(edge));
        if (!edge.deletedAt && isRoutingName(routingNameOf(edge, node.loc))) pending.push({ id: edge.targetId, flow: true });
      }
    }
    // Deliberately bind nested declarations too. compileTemplate loads its
    // partial dictionary from the root template, so a nested-only reference
    // may not render today; changing it still requires re-adoption because
    // the declared instruction definition changed (R5b-3=A).
    for (const tag of storedIncludeTags(node.content)) {
      // A URN target (#2040) is judged exactly like a loc one, plus the pin's own
      // rules for another memory: same organization, plaintext, readable by the
      // principal. Anything else is recorded as absent, so an unreadable target is
      // indistinguishable from a missing one.
      let targetMemoryId = node.memoryId;
      let loc = tag.target;
      let urn: string;
      if (tag.kind === 'urn') {
        const parts = splitNodeUrn(tag.target);
        urn = tag.target;
        const mem = await db.memory.findUnique({
          where: { urn: parts.memoryUrn },
          select: { id: true, organizationId: true, isEncrypted: true, deletedAt: true },
        });
        if (mem && !mem.deletedAt && !mem.isEncrypted && mem.organizationId === organizationId && await canReadMemory(db, principal, mem.id)) {
          targetMemoryId = mem.id;
          loc = parts.loc;
        }
      } else {
        urn = emitNodeUrnV2(node.memory.urn, loc);
      }
      if (partialRefs.has(urn)) continue;
      partialRefs.add(urn);
      if (partialRefs.size > 200) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation exceeds 200 partial references');
      const partial = await db.node.findFirst({ where: { memoryId: targetMemoryId, loc, deletedAt: null }, select: { id: true } });
      if (partial) pending.push({ id: partial.id, flow: false });
      else absentPartials.set(urn, { urn, memoryId: targetMemoryId, loc });
    }
  }
  if (Object.keys(edges).length > 1000) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph exceeds 1000 edges');
  const tools = [...flows].flatMap(id => { const node = nodes[id]; const data = node.state.data as { tools?: unknown } | null; return Array.isArray(data?.tools) ? data.tools.filter((name): name is string => typeof name === 'string') : []; });
  const resources = await executionIdentities(db, appId, organizationId, tools, selection);
  const value = { resources, format: 'hadron-automation-pin-v3' as const, appId, userId, entry, entryId, nodes, edges, flows: [...flows].sort(), absentPartials: [...absentPartials.values()].sort((a, b) => a.urn.localeCompare(b.urn)) };
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
      if (!await canReadMemory(db, principal, String(node.state.memoryId))) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation definition is not readable by its run principal', 'MEMORY_UNREADABLE');
    }
    return storedAutomationPin(preview);
  }
  catch (e) {
    if (e instanceof NodeNotFoundError || e instanceof AutomationPinError) {
      return { format: 'hadron-automation-unadopted-v1', message: 'Setup graph is missing, unreadable, encrypted or exceeds the consent bounds', ...((e instanceof NodeNotFoundError ? 'MEMORY_UNREADABLE' : e.reason) ? { reason: 'MEMORY_UNREADABLE' } : {}) };
    }
    throw e;
  }
}

/** Invalid persisted consent is never treated as an absent optional gate. */
export function parseAutomationPin(raw: unknown): AutomationPin {
  if ((raw as { format?: string })?.format === 'hadron-automation-unadopted-v1') throw new AutomationPinError('AUTOMATION_UNADOPTED', `Setup could not be adopted: ${(raw as { message: string }).message}`, (raw as { reason?: string }).reason === 'MEMORY_UNREADABLE' ? 'MEMORY_UNREADABLE' : undefined);
  const p = raw as AutomationPin | null;
  if (!p || p.format !== 'hadron-automation-pin-v3' || !p.hash || !p.entry || !p.entryId ||
      !p.nodes || !Array.isArray(p.flows) || !Array.isArray(p.absentPartials) || !p.edges || !p.resources || !p.resources.mcp || !p.resources.ha || !Array.isArray(p.resources.tools)) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation has no valid setup pin');
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
  catch (e) {
    if (!(e instanceof AutomationPinError || e instanceof NodeNotFoundError)) throw e;
    // A missing and a foreign (unreadable) memory stay indistinguishable: both carry the same typed reason (#2439).
    const unreadable = e instanceof NodeNotFoundError || e.reason === 'MEMORY_UNREADABLE';
    throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph is no longer available or readable', unreadable ? 'MEMORY_UNREADABLE' : undefined);
  }
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
  if (!pin.flows.includes(id)) throw new AutomationPinError('AUTOMATION_CHANGED', 'Child or routed flow is outside the adopted graph');
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
    revSeq: state.revSeq, deletedAt: state.deletedAt, memory: state.memory });
  const changed = new AutomationPinError('AUTOMATION_CHANGED', 'Automation revision, dependency edges or read authority changed during the hop');
  if (rows.length !== Object.keys(proof.nodes).length) throw changed;
  const touched: string[] = [];
  const edges: Record<string, string> = {};
  for (const row of rows) {
    if (hash(json(metadata(row))) !== hash(metadata(proof.nodes[row.id].state))) throw changed;
    if (json(row.updatedAt) !== proof.nodes[row.id].state.updatedAt) touched.push(row.id);
    if (proof.flows.includes(row.id)) for (const edge of row.outgoingEdges) edges[edge.id] = hash(json(edge));
  }
  if (hash(edges) !== hash(proof.edges)) throw changed;
  const principal = runAuthContext(run);
  for (const memoryId of new Set(rows.map(row => row.memoryId))) if (!await canReadMemory(db, principal, memoryId)) throw changed;
  // An operational embedding update moves updatedAt without a definition
  // revision. Re-hash just touched rows instead of rejecting an unchanged hop.
  if (touched.length) {
    const current = await db.node.findMany({ where: { id: { in: touched } }, select: DEFINITION_SELECT });
    if (current.length !== touched.length) throw changed;
    for (const node of current) {
      if (definitionHash(node) !== proof.nodes[node.id].hash) throw changed;
      proof.nodes[node.id].state.updatedAt = json(node.updatedAt);
    }
  }
  if (proof.absentPartials.length && await db.node.findFirst({ where: { OR: proof.absentPartials.map(({ memoryId, loc }) => ({ memoryId, loc, deletedAt: null })) }, select: { id: true } })) {
    throw new AutomationPinError('AUTOMATION_CHANGED', 'An instruction partial absent at adoption was created');
  }
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
