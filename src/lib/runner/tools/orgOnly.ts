/**
 * #5077 (Billing F3a, rule 4 of the slice; section 13 item 5 not yet ruled): the run tools only an organization has. Their
 * registries, counters, senders, tickets, poll bindings or GitHub installation are keyed by an organization, so a run of an
 * App a person owns cannot use them. A node naming one fails at node load, before any model call (`NODE_LOAD_FAILED`), and
 * each handler also refuses by itself ({@link requireOrgTenantForTool}) so a call that reached it another way fails too.
 */
import { type OwnerRef, orgIdOf } from '../../owner.js';

const ORG_ONLY_RUN_TOOLS: ReadonlySet<string> = new Set([
  'hadron_send_sms',
  'hadron_send_email',
  'web_poll_start',
  'web_poll_cancel',
  'web_poll_list',
  'github_issue_snapshot',
]);

/** True for a tool only an organization's run may use: the six names above and every `mcp__` and `ha__` name. */
export function isOrgOnlyRunToolName(name: string): boolean {
  return ORG_ONLY_RUN_TOOLS.has(name) || name.startsWith('mcp__') || name.startsWith('ha__');
}

/** The names a run of this tenant may not use: none for an organization, the organization-only ones for a person. */
export function orgOnlyToolsRefused(tenant: OwnerRef, names: readonly string[]): string[] {
  return orgIdOf(tenant) === null ? names.filter(isOrgOnlyRunToolName) : [];
}

/** The node-load refusal text for a person's run. */
export function orgOnlyToolsMessage(names: readonly string[]): string {
  return `Tool(s) not available to an App a person owns: ${names.join(', ')}.`;
}

/** A handler's own refusal: the run's organization id, or a throw (before any query) for a person's run. */
export function requireOrgTenantForTool(tenant: OwnerRef, toolName: string): string {
  const organizationId = orgIdOf(tenant);
  if (organizationId === null) throw new Error(orgOnlyToolsMessage([toolName]));
  return organizationId;
}
