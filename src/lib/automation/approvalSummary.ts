import { effectiveRunBudgets, type TriggerRunBudgets } from './runBudgets.js';
/**
 * #2441 (cor:agt:010:01): the plain-language projection an adopter reviews
 * before approving. Every sentence is generated here from the previewed pin,
 * never from client text. A fact the pin cannot show says "not stated", and
 * nothing here promises a bound the approval does not enforce: the hash binds
 * the definitions (flows, routing, tools, partials, registration identities),
 * not the trigger row, the write destination, the documents read or the
 * per-run budgets.
 */
import type { AutomationPreview } from './pins.js';

export interface AutomationFlowSummary { urn: string; name: string; tools: string[]; writes: string[] }
export interface AutomationSummary {
  name: string; flows: AutomationFlowSummary[]; reads: string[]; writes: string[]; tools: string[];
  schedule: string | null; limits: string[]; cannotDo: string[];
}
export interface TriggerFacts {
  kind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL';
  budgets?: TriggerRunBudgets;
  schedule?: { cron: string | null; timezone: string; runAt: Date | null; enabled: boolean };
}

const NOT_STATED = 'not stated';
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const dataOf = (state: Record<string, unknown>) => asRecord(state.data);
const toolsOf = (state: Record<string, unknown>): string[] => {
  const data = dataOf(state);
  const tools = Array.isArray(data.tools) ? data.tools.filter((t): t is string => typeof t === 'string') : [];
  // #670: the approver sees a script node's declared tool too.
  const scripted = asRecord(asRecord(data.script).call).tool;
  return [...new Set(typeof scripted === 'string' ? [...tools, scripted] : tools)].sort();
};
const nameOf = (state: Record<string, unknown>, fallback: string) => typeof state.name === 'string' && state.name ? state.name : fallback;

function writesOf(state: Record<string, unknown>, flowName: string): string[] {
  const output = asRecord(dataOf(state).output);
  const writeTo = typeof output.writeTo === 'string' && output.writeTo ? output.writeTo : null;
  const mode = typeof output.mode === 'string' && output.mode ? output.mode : null;
  if (writeTo) {
    return [`${flowName}: writes its result to ${writeTo}${mode ? ` (${mode})` : ''}. The setting is part of what you approve; the destination node and what it holds are not, and can change without a new approval.`];
  }
  return [`${flowName}: creates a new record node "runs:<run id>" beside the entry node for each run.`];
}

export function scheduleSentence(facts: TriggerFacts): string | null {
  if (facts.kind === 'WEBHOOK') return 'Starts when called. The trigger itself can change without a new approval.';
  if (facts.kind === 'MANUAL') return 'Starts when someone runs it by hand.';
  const s = facts.schedule;
  if (!s) return NOT_STATED;
  const when = s.cron ? `Runs on the schedule "${s.cron}" (${s.timezone})` : s.runAt ? `Runs once at ${s.runAt.toISOString()}` : `Runs on a schedule that is ${NOT_STATED}`;
  return `${when}${s.enabled ? '' : ' (currently switched off)'}. The schedule can change without a new approval.`;
}

export function summarizeAutomation(pin: AutomationPreview, facts: TriggerFacts): AutomationSummary {
  const flowIds = [...new Set([pin.entryId, ...pin.flows])].filter(id => Object.hasOwn(pin.nodes, id));
  const ordered = [...flowIds.filter(id => id === pin.entryId), ...flowIds.filter(id => id !== pin.entryId)
    .sort((a, b) => nameOf(pin.nodes[a].state, a).localeCompare(nameOf(pin.nodes[b].state, b)) || a.localeCompare(b))];
  const flows = ordered.map(id => {
    const state = pin.nodes[id].state;
    const name = nameOf(state, pin.nodes[id].urn);
    return { urn: pin.nodes[id].urn, name, tools: toolsOf(state), writes: writesOf(state, name) };
  });
  const entry = pin.nodes[pin.entryId];
  const partials = Object.entries(pin.nodes).filter(([id]) => !flowIds.includes(id)).map(([, n]) => n.urn).sort();
  const reads = [
    pin.userId
      ? 'Everything the run-as user can read in this App, narrowed to what the App may read.'
      : 'Everything this App can read; there is no user attached, so nothing personal.',
    ...partials.map(urn => `Instruction partial: ${urn}`),
    ...pin.absentPartials.map(p => `Instruction partial not found at approval: ${p.urn}. Creating it later needs a new approval.`),
    `Documents and data the instructions refer to: ${NOT_STATED}. Their content can change without a new approval.`,
  ];
  return {
    name: entry ? nameOf(entry.state, entry.urn) : NOT_STATED,
    flows,
    reads,
    writes: flows.flatMap(f => f.writes),
    tools: [...new Set(flows.flatMap(f => f.tools))].sort(),
    schedule: scheduleSentence(facts),
    limits: [`Per-run budgets: ${effectiveRunBudgets(facts.budgets).budgetTokens} tokens and ${effectiveRunBudgets(facts.budgets).budgetActions} actions under the current platform defaults. Later platform reductions can lower these amounts. Time and daily quotas remain platform-controlled. Trigger settings can change without a new approval; this approval itself does not enforce a maximum.`],
    cannotDo: [
      'Never reads a private memory.',
      pin.userId ? 'Never goes beyond what the run-as user, and the App, can reach.' : 'Never goes beyond what the App can reach, and never reads anyone\'s personal memory.',
    ],
  };
}

const cleanUrl = (url: unknown): string => {
  if (typeof url !== 'string') return NOT_STATED;
  try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return NOT_STATED; }
};
/** The preview the caller already gets, with registered-server URLs stripped of userinfo and query. */
export function approvalDepth(pin: AutomationPreview): Record<string, unknown> {
  const strip = (group: Record<string, { url?: unknown }>) => Object.fromEntries(Object.entries(group ?? {}).map(([slug, v]) => [slug, { ...v, url: cleanUrl(v?.url) }]));
  return JSON.parse(JSON.stringify({ ...pin, resources: { ...pin.resources, mcp: strip(pin.resources.mcp as never), ha: strip(pin.resources.ha as never) } }));
}

export function headlineOf(name: string, facts: TriggerFacts, state: 'UNADOPTED' | 'ADOPTED' | 'CHANGED'): string {
  const when = scheduleSentence(facts)?.split('. ')[0]?.replace(/\.$/, '') ?? NOT_STATED;
  const status = state === 'ADOPTED' ? 'approved' : state === 'CHANGED' ? 'changed since approval' : 'waiting for approval';
  return `${name}: ${when}; ${status}`;
}
