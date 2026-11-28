/** Non-secret execution identities included in automation consent (#1719). */
import type { PrismaClient, AiServiceConfig, McpServer, HomeAssistantInstance } from '../../generated/prisma/index.js';
import { NoAiConfigAvailableError } from '../aiConfig.js';
import { requestedAiConfigName, resolveRunAiConfig } from '../runner/runAiConfig.js';
import { type OwnerRef, orgIdOf } from '../owner.js';
import { parseMcpRunToolName } from '../mcpServers.js';
import { parseHaRunToolName } from '../homeAssistant.js';

export interface ExecutionSelection { agentId?: string | null; aiConfigName?: string | null }
export const aiIdentity = (row: AiServiceConfig) => ({ id: row.id, provider: row.provider, endpoint: row.endpoint, model: row.model, apiStyle: row.apiStyle });
export const mcpIdentity = (row: Pick<McpServer, 'id' | 'url' | 'toolAllowlist'>) => ({ id: row.id, url: row.url, allowedOps: [...row.toolAllowlist].sort() });
export const haIdentity = (row: Pick<HomeAssistantInstance, 'id' | 'url' | 'opAllowlist'>) => ({ id: row.id, url: row.url, allowedOps: [...row.opAllowlist].sort() });
export interface ExecutionIdentities {
  tools: string[];
  ai: ReturnType<typeof aiIdentity> | null;
  mcp: Record<string, ReturnType<typeof mcpIdentity> | null>;
  ha: Record<string, ReturnType<typeof haIdentity> | null>;
}
export function configSelection(row: ExecutionSelection & { eventData?: unknown }): ExecutionSelection {
  return { agentId: row.agentId, aiConfigName: row.aiConfigName ?? requestedAiConfigName(row.eventData) };
}
/** Credential columns and updatedAt are deliberately excluded: a credential
 * rotation changes neither destination nor admitted operations. */
/** #5077: `tenant` is the run's owner; a person's run has no MCP or Home Assistant registry, so every slug records as not registered. */
export async function executionIdentities(db: PrismaClient, appId: string, tenant: OwnerRef,
  tools: string[], selection: ExecutionSelection): Promise<ExecutionIdentities> {
  let ai: ExecutionIdentities['ai'] = null;
  // #5077: the one run wrapper, so a preview never shows the identity of a configuration the run would be refused.
  try { ai = aiIdentity((await resolveRunAiConfig(db, selection.aiConfigName, { appId, tenant, agentId: selection.agentId ?? undefined })).config); }
  catch (e) { if (!(e instanceof NoAiConfigAvailableError)) throw e; }
  const organizationId = orgIdOf(tenant);
  const mcpSlugs = [...new Set(tools.flatMap(name => { const part = parseMcpRunToolName(name); return part ? [part.slug] : []; }))];
  const haSlugs = [...new Set(tools.flatMap(name => { const part = parseHaRunToolName(name); return part ? [part.slug] : []; }))];
  const servers = mcpSlugs.length && organizationId !== null ? await db.mcpServer.findMany({ where: { organizationId, slug: { in: mcpSlugs }, enabled: true }, select: { slug: true, id: true, url: true, toolAllowlist: true } }) : [];
  const instances = haSlugs.length && organizationId !== null ? await db.homeAssistantInstance.findMany({ where: { organizationId, slug: { in: haSlugs }, enabled: true }, select: { slug: true, id: true, url: true, opAllowlist: true } }) : [];
  return { tools: [...new Set(tools)].sort(), ai,
    mcp: Object.fromEntries(mcpSlugs.sort().map(slug => [slug, servers.find(row => row.slug === slug) ? mcpIdentity(servers.find(row => row.slug === slug)!) : null])),
    ha: Object.fromEntries(haSlugs.sort().map(slug => [slug, instances.find(row => row.slug === slug) ? haIdentity(instances.find(row => row.slug === slug)!) : null])),
  };
}
