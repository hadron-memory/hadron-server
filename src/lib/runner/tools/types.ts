/**
 * Run-tool contracts (plan-tools D-TL-2/-3/-6) — the tools a flow node's
 * LLM may call during a hop. Naming follows the MCP convention (locked):
 * `hadron_` prefix, snake_case; policy entries are `tool.<name>`.
 *
 * Phase 1 keeps the context minimal (trail logging); the kernel
 * integration (phase 2) and node tools (phase 3) extend it with the DB
 * handle and run principal.
 */

/** What a tool handler may touch. Built by the kernel per hop. */
export interface RunToolContext {
  /** Append an author-visible line to the current hop's trail (#539). */
  log: (message: string) => void;
}

export interface RunToolDef {
  /** MCP-convention name (`hadron_create_node`); policy action is `tool.<name>`. */
  name: string;
  description: string;
  /** JSON Schema (curated subset — same posture as Node.schema, D15). */
  inputSchema: Record<string, unknown>;
  /** Action-budget cost per call (D-TL-2: writes 1; reads/log 0). */
  cost: 0 | 1;
  execute: (ctx: RunToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Thrown by `hadron_fail` — the author's DELIBERATE abort. The kernel maps
 * it to `FAILED({code: 'AUTHOR_FAIL'})`, distinct from TOOL_FAILED so the
 * audit trail reads intent, not malfunction (D-TL-6).
 */
export class AuthorFailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorFailError';
  }
}
