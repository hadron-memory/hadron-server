/**
 * The ONE place a run tool call is admitted and executed (#670, cor:agt:010:04 rule 2): both the model's tool
 * loop (`generateWithTools`) and a script node's declared call go through {@link admitAndExecuteTool}, so a
 * script node can never be a way to call a tool off the ledger. The caller's `onToolCall` is the activation
 * gate (`tool.<name>` or the definition's `policyAction`, with the tool's cost); this function runs it, then the
 * handler, and classifies what the handler throws into the terminal errors the run kernel maps to failure codes.
 */
import { AuthorFailError, type RunToolDef, type RunToolContext } from './tools/types.js';

/** The D-TL-3 gate said no: policy, cancellation, or exhausted action budget. */
export class ToolDeniedError extends Error {
  constructor(readonly tool: string) {
    super(`Tool "${tool}" denied (policy, cancellation, or action budget).`);
    this.name = 'ToolDeniedError';
  }
}

/** A handler threw: terminal TOOL_FAILED, never retried (D-TL-6 — tool side
 *  effects are not known-idempotent, so redelivery is unsafe). */
export class ToolExecutionError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Tool "${tool}" failed: ${message}`, options);
    this.name = 'ToolExecutionError';
  }
}

/** One tool call's audit entry on the hop trail (D-TL-7). */
export interface ToolCallRecord {
  name: string;
  ok: boolean;
  ms: number;
}

export interface AdmitToolOpts {
  /** Per-call governance (D-TL-3): receives the definition's policy action (default `tool.<name>`) and cost.
   *  False = deny. Absent = no gate (tests only; the kernel always supplies one). */
  onToolCall?: (action: `tool.${string}`, cost: 0 | 1) => Promise<boolean>;
  toolCtx: RunToolContext;
  /** Runs after admission and before the handler; a throw is rethrown AS IS (never re-classified) and
   *  recorded ok:false. The tool loop uses it for the #2418 sibling-terminal check. */
  beforeExecute?: () => void;
  /** Receives the call's audit entry, success or failure. */
  record?: (entry: ToolCallRecord) => void;
}

/**
 * Admit one run-tool call through the activation gate, execute its handler and return the result.
 * Throws {@link ToolDeniedError} (gate said no), the handler's {@link AuthorFailError} unwrapped, or
 * {@link ToolExecutionError} wrapping anything else. `instanceof`, not name-matching: a non-Error rejection
 * with a spoofed `name` must not ride the passthrough (PR-540 Copilot).
 */
export async function admitAndExecuteTool(
  def: RunToolDef,
  args: Record<string, unknown> | undefined,
  opts: AdmitToolOpts,
): Promise<unknown> {
  const started = Date.now();
  let passthrough = false;
  try {
    if (opts.onToolCall && !(await opts.onToolCall(def.policyAction ?? `tool.${def.name}`, def.cost))) {
      throw new ToolDeniedError(def.name);
    }
    if (opts.beforeExecute) {
      try {
        opts.beforeExecute();
      } catch (err) {
        passthrough = true;
        throw err;
      }
    }
    const result = await def.execute(opts.toolCtx, args ?? {});
    opts.record?.({ name: def.name, ok: true, ms: Date.now() - started });
    return result;
  } catch (err) {
    opts.record?.({ name: def.name, ok: false, ms: Date.now() - started });
    if (passthrough || err instanceof AuthorFailError || err instanceof ToolDeniedError) throw err;
    throw new ToolExecutionError(def.name, String((err as Error)?.message ?? err), { cause: err });
  }
}
