/**
 * #3742 (Grants S1d, cor:acl:140:02 Summary, cor:acl:140:07 What the signer reads): the one function that writes a grant's
 * summary, from the action's template, the grant's App and the grant's values, and from nothing else: not the requester's
 * reason, not an author's wording, not a node's or agent's free-text description. Pure: no database, no clock, no locale.
 * A consumer (the ceremony page, a `summary` field) resolves each node reference behind its own read gate and passes it in.
 *
 * Rendering is a spec line, ruled by Holger (ruling 0258): the App and every referenced node are written as their
 * canonical URN, never by a name or any other free text. A name can be text the requester wrote, and the server's own
 * sentence must never carry it. Built as written ("built as", not ruled) on the Proposed lines of cor:acl:140:02/:07.
 */
import { parseSecretUrnV2, parseUrnV2 } from '@hadron-memory/urn-lib-js';
import type { ActionParameter } from './actions.js';

export type GrantSummaryReason =
  | 'MISSING_VALUE' | 'UNSUPPORTED_TYPE' | 'WILDCARD' | 'LIST' | 'UNKNOWN_PLACEHOLDER' | 'MALFORMED_TEMPLATE' | 'NOT_CANONICAL';

/** The summary cannot be written. The message names a placeholder, never a value. Nothing is ever printed in its place. */
export class GrantSummaryError extends Error {
  readonly code = 'GRANT_SUMMARY_UNRENDERABLE' as const;
  constructor(readonly reason: GrantSummaryReason, message: string) {
    super(message);
    this.name = 'GrantSummaryError';
  }
}

export interface SummaryAction { parameters: readonly ActionParameter[]; summaryTemplate: string }
export interface SummaryInput {
  action: SummaryAction;
  /** The grant's App, by its canonical URN. */
  app: { urn: string };
  /** The grant's values, by parameter name. A `node-ref` value is the key into `refs`. */
  values: Readonly<Record<string, unknown>>;
  /** Each stored `node-ref` value resolved to its node's canonical URN. */
  refs: Readonly<Record<string, { urn: string }>>;
}

const TOKEN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * The placeholder names of a template, in order. Throws when any brace is left once the valid `{name}` tokens are removed
 * (`{}`, `{{app}}`, `{ app }`, a stray `{` or `}`): a typo is refused, never printed as a literal.
 */
export function summaryPlaceholders(template: string): string[] {
  const names = [...template.matchAll(TOKEN)].map((m) => m[1]);
  if (/[{}]/.test(template.replace(TOKEN, ''))) {
    throw new GrantSummaryError('MALFORMED_TEMPLATE', 'summary template has a brace that is not part of a {name} placeholder');
  }
  return names;
}

const URN_KIND = { app: 'app', 'node-ref': 'node' } as const;
/**
 * The whole string must be a canonical grammar-v2 URN of the right entity kind: the strict v2 parser accepts it whole (so no
 * space, control character, brace or trailing text can ride behind a valid prefix) and carries no `#` fragment. A caller that
 * hands in a name, an alias or a half-URN is refused, never repaired.
 */
function canonical(kind: keyof typeof URN_KIND, placeholder: string, urn: unknown): string {
  let ok = false;
  if (typeof urn === 'string') {
    try { const p = parseUrnV2(urn); ok = p.type === URN_KIND[kind] && p.fragment === undefined; } catch { ok = false; }
  }
  if (!ok) throw new GrantSummaryError('NOT_CANONICAL', `summary placeholder {${placeholder}} needs a canonical ${URN_KIND[kind]} URN`);
  return urn as string;
}
/** An App secret's canonical URN (urn-lib-js 0.0.22, cor:urn:010:01): the typed parse must say it is an App secret, and nothing may trail it. */
function canonicalSecret(placeholder: string, urn: unknown): string {
  let ok = false;
  if (typeof urn === 'string') {
    try { ok = parseSecretUrnV2(urn).ownerKind === 'app' && !urn.includes('#'); } catch { ok = false; }
  }
  if (!ok) throw new GrantSummaryError('NOT_CANONICAL', `summary placeholder {${placeholder}} needs a canonical App secret URN`);
  return urn as string;
}
export const SUMMARY_FORMATTERS = {
  app: (urn: string) => canonical('app', 'app', urn),
  'node-ref': (urn: string, placeholder: string) => canonical('node-ref', placeholder, urn),
  'secret-ref': (urn: string, placeholder: string) => canonicalSecret(placeholder, urn),
} as const;

export type SummaryFormatters = { app: (urn: string) => string; 'node-ref': (urn: string, placeholder: string) => string; 'secret-ref': (urn: string, placeholder: string) => string };

export function renderGrantSummary(input: SummaryInput, fmt: SummaryFormatters = SUMMARY_FORMATTERS): string {
  const { action, app, values, refs } = input;
  const names = summaryPlaceholders(action.summaryTemplate);
  const params = new Map(action.parameters.map((p) => [p.name, p] as const));
  // Every placeholder is resolved before any text is written, so a refusal never leaves a half-built sentence.
  const resolved = new Map<string, string>();
  for (const name of names) {
    if (resolved.has(name)) continue;
    if (name === 'app') { resolved.set(name, fmt.app(app?.urn)); continue; }
    const param = params.get(name);
    if (!param) throw new GrantSummaryError('UNKNOWN_PLACEHOLDER', `summary placeholder {${name}} is not a parameter of the action`);
    const value = values[name];
    if (value === undefined || value === null || value === '') throw new GrantSummaryError('MISSING_VALUE', `summary placeholder {${name}} has no value`);
    if (Array.isArray(value)) throw new GrantSummaryError('LIST', `summary placeholder {${name}} has a list value`);
    if (value === '*' || typeof value === 'object') throw new GrantSummaryError('WILDCARD', `summary placeholder {${name}} has a wildcard or structured value`);
    if (param.type !== 'node-ref' && param.type !== 'secret-ref') throw new GrantSummaryError('UNSUPPORTED_TYPE', `summary placeholder {${name}} has a parameter type the summary cannot write`);
    if (typeof value !== 'string') throw new GrantSummaryError('UNSUPPORTED_TYPE', `summary placeholder {${name}} has a value of a type the summary cannot write`);
    const ref = Object.prototype.hasOwnProperty.call(refs, value) ? refs[value] : undefined;
    if (!ref) throw new GrantSummaryError('MISSING_VALUE', `summary placeholder {${name}} has no resolved node`);
    resolved.set(name, param.type === 'secret-ref' ? fmt['secret-ref'](ref.urn, name) : fmt['node-ref'](ref.urn, name));
  }
  // One pass: String.replace never re-reads what it inserted, so a value that looks like a placeholder is printed once, literally.
  return action.summaryTemplate.replace(TOKEN, (_whole, name: string) => resolved.get(name)!);
}
