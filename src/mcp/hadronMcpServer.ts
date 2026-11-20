/**
 * The MCP server type every Hadron tool file registers against (#2605, SDK 2.x step 1).
 *
 * SDK 2.x removed `McpServer.tool(name, description, shape, handler)`; its replacement is
 * `registerTool(name, { description, inputSchema }, handler)`. Hadron keeps the positional `server.tool(` call
 * shape on purpose:
 *
 * - every registration already passes through one gate in `createMcpServerInstance` (the error boundary, the
 *   `session` argument, the actor scope), and that gate is what calls the SDK;
 * - `server.tool(` is a cross-repo text contract: hadron-cli's `scripts/gen-tools-manifest.sh` scrapes it (see
 *   ./disabledTools.ts).
 *
 * So `tool` here is Hadron's own method, installed by that gate, and the only place that names the SDK's
 * registration call is {@link registerLegacyTool}.
 */
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** A plain record of zod field schemas: the parameter shape a tool declares (a module-scope `SHAPE_*`, #2260). */
export type ToolParamShape = Record<string, z.ZodType>;

/** What a tool handler may return. */
export type ToolHandlerResult = CallToolResult | Promise<CallToolResult>;

/** `server.tool(name, description, shape, handler)`: the one registration form Hadron tools use. */
export type LegacyToolRegistrar = <Shape extends ToolParamShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ServerContext) => ToolHandlerResult,
) => void;

/** The SDK server plus Hadron's positional `tool` method. */
export type HadronMcpServer = McpServer & { tool: LegacyToolRegistrar };

/**
 * One `z.object` per parameter shape for the life of the process. The shapes are module-scope objects shared by
 * every server instance (#2260); wrapping one per registration would rebuild an object schema per tool per instance.
 */
const objectSchemaByShape = new WeakMap<object, z.ZodObject<ToolParamShape>>();
export function objectSchemaFor(shape: ToolParamShape): z.ZodObject<ToolParamShape> {
  let schema = objectSchemaByShape.get(shape);
  if (!schema) {
    schema = z.object(shape);
    objectSchemaByShape.set(shape, schema);
  }
  return schema;
}

/**
 * Register a tool given in the positional form with the SDK. `args` is `(name, description, shape, handler)`; the
 * gate in `createMcpServerInstance` may have replaced the shape (the added `session` field) and the handler.
 */
export function registerLegacyTool(server: McpServer, args: readonly unknown[]): void {
  const [name, description, shape, handler] = args;
  if (args.length !== 4 || typeof name !== 'string' || typeof description !== 'string'
    || typeof shape !== 'object' || shape === null || typeof handler !== 'function') {
    throw new Error(`tool ${String(name)}: expected (name, description, shape, handler)`);
  }
  server.registerTool(
    name,
    { description, inputSchema: objectSchemaFor(shape as ToolParamShape) },
    handler as (args: Record<string, unknown>, ctx: ServerContext) => ToolHandlerResult,
  );
}

/**
 * Give an SDK server the positional `tool` method with no gate in front of it. `createMcpServerInstance` installs
 * its own gated method instead; this is for a tool file registered on a bare server (tests that exercise one file).
 */
export function withPositionalTool(server: McpServer): HadronMcpServer {
  const hadron = server as HadronMcpServer;
  hadron.tool = ((...args: unknown[]) => registerLegacyTool(server, args)) as LegacyToolRegistrar;
  return hadron;
}
