/**
 * #670 / cor:agt:010:04 rule 3 — arguments of a script node's declared call are rendered against the run's
 * merged view BEFORE the call. A placeholder with no value refuses the hop (nothing is sent with an empty
 * field). Same `{{name}}` / `{{a.b}}` syntax as the run's prompt templating, with one deliberate difference:
 * the value is inserted as-is, never HTML-escaped (an argument is data for a tool, not markup), and an argument
 * that is exactly one placeholder keeps the value's own type (a number stays a number).
 */

/** A `{{variable}}` in a script call's args has no value in the merged view. */
export class ScriptVariableMissingError extends Error {
  constructor(readonly variable: string) {
    super(`Script node argument refers to "{{${variable}}}", which has no value; the call was not made.`);
    this.name = 'ScriptVariableMissingError';
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\s*\}\}/g;

function lookup(view: Record<string, unknown>, path: string): unknown {
  let cur: unknown = view;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      throw new ScriptVariableMissingError(path);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === undefined || cur === null || cur === '') throw new ScriptVariableMissingError(path);
  return cur;
}

function renderValue(value: unknown, view: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\s*\}\}$/);
    if (whole) return lookup(view, whole[1]!);
    return value.replace(PLACEHOLDER, (_m, path: string) => {
      const v = lookup(view, path);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, view));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderValue(v, view)]));
  }
  return value;
}

/** Render a script call's args against the merged view; throws {@link ScriptVariableMissingError}. */
export function renderScriptArgs(args: Record<string, unknown>, view: Record<string, unknown>): Record<string, unknown> {
  return renderValue(args, view) as Record<string, unknown>;
}
