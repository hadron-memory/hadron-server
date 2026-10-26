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
/** Pin formats. v3 (#1719) keys the entry by its literal URN and hashes node
 * and edge rows INCLUDING their loc — a same-memory rename or move of the
 * entry invalidates it. v4 (#2438) keys the entry by node id and hashes
 * content plus memoryId only (addresses are display, never identity), so a
 * move WITHIN one memory is not a change, while a move to ANOTHER memory
 * changes memoryId and still is (Vera's ruling on #2438 over cor:agt:010:01).
 * Stored v3 pins verify forever under v3 semantics — never a silent unadopt —
 * and every capture after this lands writes v4. */
export type AutomationPinFormat = 'hadron-automation-pin-v3' | 'hadron-automation-pin-v4';
interface PinBase {
  appId: string; userId: string | null; entryId: string;
  edges: Record<string, string>; resources: ExecutionIdentities;
  flows: string[]; absentPartials: Array<{ urn: string; memoryId: string; loc: string }>;
}
export interface AutomationPin extends PinBase {
  format: 'hadron-automation-pin-v3';
  entry: string; hash: string;
  nodes: Record<string, { urn: string; hash: string }>;
}
export interface AutomationPinV4 extends PinBase {
  format: 'hadron-automation-pin-v4';
  hash: string;
  nodes: Record<string, string>;
}
export type ParsedAutomationPin = AutomationPin | AutomationPinV4;
const hash = (value: unknown) => createHash('sha256').update(canonicalizeAutomationJson(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
/** An edge's v4 fingerprint drops its derived loc (the address moveNode
 * rebases); every other column — including memoryId, so a cross-memory hop
 * stays a change — is identity. */
const edgeState = (format: AutomationPinFormat, edge: Record<string, unknown>) =>
  format === 'hadron-automation-pin-v3' ? edge :(({ loc: _, ...rest }) => rest)(edge);

// v3's capture shape is FROZEN: stored v3 pins verify against these exact
// fields, so any edit here desyncs every legacy adoption at once. The two
// address fields (node loc, memory urn) stay IN the select for both formats —
// the walk needs them (routing names, display URNs); v4 strips them from the
// hashed and previewed state instead (stripAddresses below).
const DEFINITION_SELECT = {
  id: true, memoryId: true, loc: true, name: true, content: true, description: true, abstract: true,
  data: true, properties: true, tags: true, seq: true, nodeType: true, role: true,
  objectType: true, isRunnable: true, revSeq: true, updatedAt: true, deletedAt: true,
  memory: { select: { urn: true, organizationId: true, class: true, userId: true,
    ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true } },
} as const;
/** v4 (#2438) hashes content plus memoryId only: the two address fields are
 * display, never identity, so a same-memory rename or move of any pinned node
 * is not a change. memoryId and the memory's trust columns stay hashed, so an
 * ownership/class/encryption flip — or a move to ANOTHER memory — still is. */
const stripAddresses = (format: AutomationPinFormat, state: Record<string, unknown>): Record<string, unknown> =>
  format === 'hadron-automation-pin-v3' ? state
    : (({ loc: _loc, memory, ...rest }) => ({ ...rest, memory: (({ urn: _urn, ...mem }) => mem)(memory as Record<string, unknown>) }))(state);
const definitionHash = (format: AutomationPinFormat, state: Record<string, unknown>) => {
  const { updatedAt: _, ...authored } = stripAddresses(format, state);
  if (format === 'hadron-automation-pin-v3') return hash(json(authored));
  // v4 also drops revSeq: it is a write counter, and a pure address move
  // bumps it without touching content (#2438) — it stays in the previewed
  // state, where checkAutomationRevisions still uses it as the hop tripwire.
  const { revSeq: _rev, ...content } = authored;
  return hash(json(content));
};

/** Capture routed flow definitions and instruction partials. Documents, data
 * references and output destinations remain mutable, read-gated data (#7894). */
export interface AutomationPreview extends PinBase {
  format: AutomationPinFormat; entry: string; hash: string;
  nodes: Record<string, { urn: string; hash: string; state: Record<string, unknown> }>;
}
/** Persist only consent identities and digests. Preview bytes never leave the response. */
/** Persist only consent identities and digests. Preview bytes never leave the
 * response. Accepts a preview OR an already-stored pin (re-storing is the
 * identity — same bytes, same digest), which is what adoption round-trips and
 * the mint-time pin copy rely on. */
export function storedAutomationPin(pin: AutomationPreview | AutomationPin | AutomationPinV4): ParsedAutomationPin {
  if (pin.format === 'hadron-automation-pin-v3') {
    // FROZEN v3 shape: entry is part of the hashed identity and every stored
    // node carries its urn; do not add, drop or reorder fields here.
    const { hash: _, nodes, ...base } = pin;
    const value = { ...base, nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { urn: node.urn, hash: node.hash }])) } as AutomationPin;
    return { ...value, hash: hash(value) };
  }
  // v4 keys nodes by id→hash and carries no entry address at all (#2438):
  // entry is dropped, never re-added — the row's entryNodeUrn is the display
  // address, and entryId is the identity.
  const { hash: _, nodes, ...rest } = pin as AutomationPreview | AutomationPinV4;
  const { entry: _entry, ...base } = rest as typeof rest & { entry?: unknown };
  const value = { ...base, nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, typeof node === 'string' ? node : node.hash])) } as AutomationPinV4;
  return { ...value, hash: hash(value) };
}
export async function captureAutomationPin(db: PrismaClient, appId: string, userId: string | null,
  entry: string, organizationId: string, principal: AuthContext, selection: ExecutionSelection = {},
  opts: { format?: AutomationPinFormat } = {}): Promise<AutomationPreview> {
  const format = opts.format ?? 'hadron-automation-pin-v4';
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
    const { outgoingEdges, ...rowState } = node;
    nodes[id] = { urn: emitNodeUrnV2(node.memory.urn, node.loc), hash: definitionHash(format, rowState), state: json(stripAddresses(format, rowState)) };
    // Include tombstones in the edge fingerprint: add/delete/revive must not
    // erase evidence of a post-adoption graph edit.
    if (flow) {
      processedFlows.add(id);
      for (const edge of outgoingEdges) {
        edges[edge.id] = hash(json(edgeState(format, edge)));
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
  const value = { resources, format, appId, userId, entry, entryId, nodes, edges, flows: [...flows].sort(), absentPartials: [...absentPartials.values()].sort((a, b) => a.urn.localeCompare(b.urn)) };
  const result: AutomationPreview = { ...value, hash: storedAutomationPin({ ...value, hash: '' }).hash };
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
export function parseAutomationPin(raw: unknown): ParsedAutomationPin {
  if ((raw as { format?: string })?.format === 'hadron-automation-unadopted-v1') throw new AutomationPinError('AUTOMATION_UNADOPTED', `Setup could not be adopted: ${(raw as { message: string }).message}`, (raw as { reason?: string }).reason === 'MEMORY_UNREADABLE' ? 'MEMORY_UNREADABLE' : undefined);
  const p = raw as AutomationPin | AutomationPinV4 | null;
  if (!p || (p.format !== 'hadron-automation-pin-v3' && p.format !== 'hadron-automation-pin-v4') || !p.hash || !p.entryId ||
      !p.nodes || !Array.isArray(p.flows) || !Array.isArray(p.absentPartials) || !p.edges || !p.resources || !p.resources.mcp || !p.resources.ha || !Array.isArray(p.resources.tools)) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation has no valid setup pin');
  if (p.format === 'hadron-automation-pin-v3') {
    if (!p.entry || Object.values(p.nodes).some(node => !node || typeof node.urn !== 'string' || typeof node.hash !== 'string' || Object.keys(node).some(key => !['urn', 'hash'].includes(key)))) throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation pin contains unsupported node data');
  } else if (Object.values(p.nodes).some(node => typeof node !== 'string')) {
    throw new AutomationPinError('AUTOMATION_UNADOPTED', 'Automation pin contains unsupported node data');
  }
  const { hash: digest, ...state } = p;
  if (hash(state) !== digest) throw new AutomationPinError('AUTOMATION_CHANGED', 'Stored automation pin is corrupt');
  return p;
}

/** Validate the entire setup before any hop executes, and before each effect.
 * A resumed run retains its original consent even if its trigger re-adopts. */
export async function verifyAutomationPin(db: PrismaClient, run: AppRun, nodeUrn = run.entryNodeUrn): Promise<AutomationPreview> {
  const pin = parseAutomationPin(run.automationPin);
  // v3 keys the entry by its literal URN (the address IS identity); v4 keys
  // it by the node id, so a renamed or moved entry keeps verifying (#2438).
  const entryRef = pin.format === 'hadron-automation-pin-v3' ? pin.entry : pin.entryId;
  if (pin.appId !== run.appId || pin.userId !== run.userId ||
      (['SCHEDULE', 'WEBHOOK', 'MANUAL'].includes(run.triggerKind)
        && (pin.format === 'hadron-automation-pin-v3' ? pin.entry !== run.entryNodeUrn : pin.entryId !== run.entryNodeId))) throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation identity changed');
  let current: AutomationPreview;
  try { current = await captureAutomationPin(db, run.appId, run.userId, entryRef, run.organizationId, runAuthContext(run), configSelection(run), { format: pin.format }); }
  catch (e) {
    if (!(e instanceof AutomationPinError || e instanceof NodeNotFoundError)) throw e;
    // A missing and a foreign (unreadable) memory stay indistinguishable: both carry the same typed reason (#2439).
    const unreadable = e instanceof NodeNotFoundError || e.reason === 'MEMORY_UNREADABLE';
    throw new AutomationPinError('AUTOMATION_CHANGED', 'Automation graph is no longer available or readable', unreadable ? 'MEMORY_UNREADABLE' : undefined);
  }
  if (current.hash !== pin.hash) {
    const storedNodeHash = (id: string) => pin.format === 'hadron-automation-pin-v3' ? pin.nodes[id]?.hash : pin.nodes[id];
    const changedNodes = [...new Set([...Object.keys(pin.nodes), ...Object.keys(current.nodes)])]
      .filter(id => storedNodeHash(id) !== current.nodes[id]?.hash).map(id => current.nodes[id]?.urn ?? (pin.format === 'hadron-automation-pin-v3' ? pin.nodes[id]?.urn : id));
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
  // v3 proofs (legacy resumed runs) compare the frozen v3 fields; v4 drops
  // the two address fields, matching its capture select (#2438).
  const v3 = proof.format === 'hadron-automation-pin-v3';
  const rows = await db.node.findMany({ where: { id: { in: Object.keys(proof.nodes) } }, select: {
    id: true, memoryId: true, ...(v3 ? { loc: true } : {}), revSeq: true, updatedAt: true, deletedAt: true,
    memory: { select: v3
      ? { urn: true, organizationId: true, class: true, userId: true, ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true }
      : { organizationId: true, class: true, userId: true, ownerUserId: true, appId: true, isEncrypted: true, deletedAt: true } },
    outgoingEdges: { orderBy: { id: 'asc' } },
  } });
  const metadata = (state: Record<string, unknown>) => v3
    ? { id: state.id, memoryId: state.memoryId, loc: state.loc, revSeq: state.revSeq, deletedAt: state.deletedAt, memory: state.memory }
    : { id: state.id, memoryId: state.memoryId, revSeq: state.revSeq, deletedAt: state.deletedAt, memory: state.memory };
  const message = 'Automation revision, dependency edges or read authority changed during the hop';
  const changed = new AutomationPinError('AUTOMATION_CHANGED', message);
  // #2439: losing read access mid-hop is typed like the pre-hop path; a missing node reads the same (indistinguishable).
  const unreadable = new AutomationPinError('AUTOMATION_CHANGED', message, 'MEMORY_UNREADABLE');
  const principal = runAuthContext(run);
  if (rows.length !== Object.keys(proof.nodes).length) throw unreadable;
  const touched: string[] = [];
  const edges: Record<string, string> = {};
  for (const row of rows) {
    if (hash(json(metadata(row))) !== hash(metadata(proof.nodes[row.id].state))) {
      throw await canReadMemory(db, principal, row.memoryId) ? changed : unreadable;
    }
    if (json(row.updatedAt) !== proof.nodes[row.id].state.updatedAt) touched.push(row.id);
    if (proof.flows.includes(row.id)) for (const edge of row.outgoingEdges) edges[edge.id] = hash(json(edgeState(proof.format, edge)));
  }
  if (hash(edges) !== hash(proof.edges)) throw changed;
  for (const memoryId of new Set(rows.map(row => row.memoryId))) if (!await canReadMemory(db, principal, memoryId)) throw unreadable;
  // An operational embedding update moves updatedAt without a definition
  // revision. Re-hash just touched rows instead of rejecting an unchanged hop.
  if (touched.length) {
    const current = await db.node.findMany({ where: { id: { in: touched } }, select: DEFINITION_SELECT });
    if (current.length !== touched.length) throw changed;
    for (const node of current) {
      if (definitionHash(proof.format, node) !== proof.nodes[node.id].hash) throw changed;
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
