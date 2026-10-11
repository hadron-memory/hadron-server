/** Non-secret execution identities included in automation consent (#1719). */
import type { PrismaClient, AiServiceConfig, McpServer, HomeAssistantInstance } from '../../generated/prisma/index.js';
import { resolveAiConfigWithFallback, NoAiConfigAvailableError } from '../aiConfig.js';
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
  const override = (row.eventData as Record<string, unknown> | null)?.__aiConfigName;
  return { agentId: row.agentId, aiConfigName: row.aiConfigName ?? (typeof override === 'string' ? override : null) };
}
/** Credential columns and updatedAt are deliberately excluded: a credential
 * rotation changes neither destination nor admitted operations. */
export async function executionIdentities(db: PrismaClient, appId: string, organizationId: string,
  tools: string[], selection: ExecutionSelection): Promise<ExecutionIdentities> {
  let ai: ExecutionIdentities['ai'] = null;
  try { ai = aiIdentity((await resolveAiConfigWithFallback(db, selection.aiConfigName, { appId, organizationId, agentId: selection.agentId ?? undefined })).config); }
  catch (e) { if (!(e instanceof NoAiConfigAvailableError)) throw e; }
  const mcpSlugs = [...new Set(tools.flatMap(name => { const part = parseMcpRunToolName(name); return part ? [part.slug] : []; }))];
  const haSlugs = [...new Set(tools.flatMap(name => { const part = parseHaRunToolName(name); return part ? [part.slug] : []; }))];
  const servers = mcpSlugs.length ? await db.mcpServer.findMany({ where: { organizationId, slug: { in: mcpSlugs }, enabled: true }, select: { slug: true, id: true, url: true, toolAllowlist: true } }) : [];
  const instances = haSlugs.length ? await db.homeAssistantInstance.findMany({ where: { organizationId, slug: { in: haSlugs }, enabled: true }, select: { slug: true, id: true, url: true, opAllowlist: true } }) : [];
  return { tools: [...new Set(tools)].sort(), ai,
    mcp: Object.fromEntries(mcpSlugs.sort().map(slug => [slug, servers.find(row => row.slug === slug) ? mcpIdentity(servers.find(row => row.slug === slug)!) : null])),
    ha: Object.fromEntries(haSlugs.sort().map(slug => [slug, instances.find(row => row.slug === slug) ? haIdentity(instances.find(row => row.slug === slug)!) : null])),
  };
}
