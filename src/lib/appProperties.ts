/**
 * #3125 S1 — an App's own `properties` (cor:dmo:050:02, cor:dmo:050:20) and the task-integration namespace the
 * platform reads inside it (cor:agt:120:01).
 *
 * The object is the team's: every key but `taskIntegrations` is stored and returned as given, and is never matcher or
 * authorization input. The write rules, judged in this order after the manager gate (so a caller who doesn't manage
 * the App gets the same refusal whatever the object holds):
 *   1. a JSON object (or null to clear)                         → PROPERTIES_NOT_AN_OBJECT
 *   2. at most 64 levels deep and 16 KiB of canonical JSON      → PROPERTIES_TOO_LARGE (names the path)
 *   2a. no key named `__proto__`, at any depth                  → PROPERTIES_KEY_RESERVED (names the path)
 *   3. `taskIntegrations` only on an App with an organization   → TASK_INTEGRATION_ORG_REQUIRED (#3125 Ask 5)
 *   4. `taskIntegrations` well-formed                           → TASK_INTEGRATION_INVALID (names the path)
 * A refusal names a JSON path, never a value (V47).
 *
 * Stored shape of a team map entry: `{ lead: <worker id>, label }`, so a rename never breaks it; the read projection
 * turns the id back into the worker's URN.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { canonicalJson } from './agentTasks/properties.js';

export const APP_PROPERTIES_MAX_BYTES = 16 * 1024;
export const APP_PROPERTIES_MAX_DEPTH = 64;

/** The one key the platform reads (cor:agt:120:01). */
export const TASK_INTEGRATIONS_KEY = 'taskIntegrations';
/** cor:agt:120:01: the closed provider set. */
export const TASK_INTEGRATION_PROVIDERS = ['github'] as const;

const NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/;
const LABEL_MAX = 100;
const REPOSITORIES_MAX = 50;
const EXCLUDE_LABELS_MAX = 50;
const TEAMS_MAX = 50;
const INTEGRATION_KEYS = new Set(['name', 'provider', 'repositories', 'readyLabel', 'excludeLabels', 'teams']);
const TEAM_KEYS = new Set(['lead', 'label']);
// eslint-disable-next-line no-control-regex
const CONTROL_OR_FORMAT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/u;

const refusal = (code: string, message: string, path?: string) =>
  new GraphQLError(message, { extensions: path === undefined ? { code } : { code, path } });

const invalid = (path: string, what: string) =>
  refusal('TASK_INTEGRATION_INVALID', `properties.${path}: ${what}`, path);

export type StoredTeam = { lead: string; label: string };
export type StoredTaskIntegration = {
  name: string;
  provider: (typeof TASK_INTEGRATION_PROVIDERS)[number];
  repositories: string[];
  readyLabel?: string;
  excludeLabels?: string[];
  teams?: StoredTeam[];
};

/** The path of the first value nested deeper than `max` levels, found without recursion; null when none is. */
function tooDeepPath(value: object, max: number): string | null {
  const stack: Array<[object, number, string]> = [[value, 1, '']];
  while (stack.length > 0) {
    const [node, depth, path] = stack.pop() as [object, number, string];
    if (depth > max) return path;
    for (const [k, child] of Object.entries(node)) {
      if (child !== null && typeof child === 'object') {
        const at = Array.isArray(node) ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`;
        stack.push([child, depth + 1, at]);
      }
    }
  }
  return null;
}

/**
 * The path of the first object key named `__proto__`, at any depth; null when none is. PR #3131 blind P2: the Prisma
 * JSON writer drops such an own key, so the row would silently store something other than what was sent (and a
 * write of `{"__proto__": ...}` would bump the revision for an unchanged `{}`). Refused instead of stored lossily.
 */
function reservedKeyPath(value: object): string | null {
  const stack: Array<[object, string]> = [[value, '']];
  while (stack.length > 0) {
    const [node, path] = stack.pop() as [object, string];
    for (const k of Object.keys(node)) {
      const at = Array.isArray(node) ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`;
      if (!Array.isArray(node) && k === '__proto__') return at;
      const child = (node as Record<string, unknown>)[k];
      if (child !== null && typeof child === 'object') stack.push([child, at]);
    }
  }
  return null;
}

/** Checks 1, 2 and 2a. */
export function checkAppPropertiesShape(value: unknown): Prisma.InputJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw refusal('PROPERTIES_NOT_AN_OBJECT', 'properties must be a JSON object (or null to clear them).');
  }
  const deep = tooDeepPath(value, APP_PROPERTIES_MAX_DEPTH);
  if (deep !== null) {
    throw refusal('PROPERTIES_TOO_LARGE', `properties.${deep} nests deeper than ${APP_PROPERTIES_MAX_DEPTH} levels.`, deep);
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > APP_PROPERTIES_MAX_BYTES) {
    throw refusal('PROPERTIES_TOO_LARGE', `properties may hold at most ${APP_PROPERTIES_MAX_BYTES} bytes of JSON.`, '');
  }
  const reserved = reservedKeyPath(value);
  if (reserved !== null) {
    throw refusal('PROPERTIES_KEY_RESERVED', `properties.${reserved}: the key __proto__ cannot be stored. Nothing was changed.`, reserved);
  }
  return value as Prisma.InputJsonObject;
}

function label(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LABEL_MAX) {
    throw invalid(path, `a label is text of 1 to ${LABEL_MAX} characters.`);
  }
  if (CONTROL_OR_FORMAT.test(raw)) throw invalid(path, 'a label may not contain control or invisible format characters.');
  return raw;
}

function list(raw: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    throw invalid(path, `must be a list of ${min} to ${max} entries.`);
  }
  return raw;
}

function plainObject(raw: unknown, path: string, allowed: Set<string>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(path, 'must be an object.');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !allowed.has(k));
  if (extra !== undefined) throw invalid(path, `has a field the platform does not know (allowed: ${[...allowed].join(', ')}).`);
  return o;
}

/**
 * Resolve a team lead ref (URN, id or name) to a live worker of THIS App, or null. An unknown ref, a retired worker
 * and another App's worker all answer null, so the refusal is the same for each.
 */
export type LeadResolver = (ref: string) => Promise<string | null>;

/** Check 4: validate `taskIntegrations` and return its stored form (leads as worker ids, repositories lower-cased). */
export async function normalizeTaskIntegrations(raw: unknown, resolveLead: LeadResolver): Promise<StoredTaskIntegration[]> {
  if (!Array.isArray(raw)) throw invalid(TASK_INTEGRATIONS_KEY, 'must be a list of integrations.');
  const entries: unknown[] = raw;
  const names = new Set<string>();
  const out: StoredTaskIntegration[] = [];
  for (const [i, entry] of entries.entries()) {
    const at = `${TASK_INTEGRATIONS_KEY}[${i}]`;
    const o = plainObject(entry, at, INTEGRATION_KEYS);
    if (typeof o.name !== 'string' || !NAME_PATTERN.test(o.name)) {
      throw invalid(`${at}.name`, 'a name is 1 to 40 lower-case letters, digits or hyphens.');
    }
    if (names.has(o.name)) throw invalid(`${at}.name`, 'another integration of this App already has this name.');
    names.add(o.name);
    if (!(TASK_INTEGRATION_PROVIDERS as readonly unknown[]).includes(o.provider)) {
      throw invalid(`${at}.provider`, `the provider must be one of: ${TASK_INTEGRATION_PROVIDERS.join(', ')}.`);
    }
    const repositories: string[] = [];
    for (const [r, repo] of list(o.repositories, `${at}.repositories`, 1, REPOSITORIES_MAX).entries()) {
      const rp = `${at}.repositories[${r}]`;
      const parts = typeof repo === 'string' ? repo.split('/') : [];
      if (parts.length !== 2 || !parts.every((p) => REPOSITORY_SEGMENT.test(p) && p !== '.' && p !== '..')) {
        throw invalid(rp, 'a repository is "owner/name".');
      }
      const lower = (repo as string).toLowerCase();
      if (repositories.includes(lower)) throw invalid(rp, 'this repository is already listed.');
      repositories.push(lower);
    }
    const stored: StoredTaskIntegration = { name: o.name, provider: o.provider as StoredTaskIntegration['provider'], repositories };
    if (o.readyLabel !== undefined) stored.readyLabel = label(o.readyLabel, `${at}.readyLabel`);
    if (o.excludeLabels !== undefined) {
      stored.excludeLabels = list(o.excludeLabels, `${at}.excludeLabels`, 0, EXCLUDE_LABELS_MAX)
        .map((l, j) => label(l, `${at}.excludeLabels[${j}]`));
    }
    if (o.teams !== undefined) {
      const leads = new Set<string>();
      stored.teams = [];
      for (const [t, team] of list(o.teams, `${at}.teams`, 0, TEAMS_MAX).entries()) {
        const tp = `${at}.teams[${t}]`;
        const to = plainObject(team, tp, TEAM_KEYS);
        const ref = typeof to.lead === 'string' ? to.lead.trim() : '';
        const workerId = ref === '' ? null : await resolveLead(ref);
        if (workerId === null) throw invalid(`${tp}.lead`, 'the lead must be a worker of this App that is not retired.');
        if (leads.has(workerId)) throw invalid(`${tp}.lead`, 'this worker already leads another team of this integration.');
        leads.add(workerId);
        stored.teams.push({ lead: workerId, label: label(to.label, `${tp}.label`) });
      }
    }
    out.push(stored);
  }
  return out;
}

/**
 * The top-level keys whose value differs between two objects (null = none), sorted. Values never leave here.
 * OWN keys only (PR #3131 blind P2): `in` and a plain lookup see Object.prototype, so a JSON key named `__proto__`
 * would read as present on an empty object and its write or removal would be dropped as a no-op.
 */
export function changedTopLevelKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const a = before ?? {}, b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((k) => !Object.hasOwn(a, k) || !Object.hasOwn(b, k) || canonicalJson(a[k]) !== canonicalJson(b[k]))
    .sort();
}

/**
 * The read projection: the stored object with each team lead's worker id replaced by the worker's URN. A lead whose
 * worker row is gone reads as null (its URN can no longer be composed).
 */
export async function projectAppProperties(
  stored: unknown,
  leadUrns: (workerIds: string[]) => Promise<Map<string, string>>,
): Promise<Record<string, unknown> | null> {
  if (stored === null || stored === undefined || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const obj = stored as Record<string, unknown>;
  const integrations = obj[TASK_INTEGRATIONS_KEY];
  if (!Array.isArray(integrations)) return obj;
  const ids = integrations.flatMap((i) => (Array.isArray(i?.teams) ? i.teams.map((t: StoredTeam) => t.lead) : []));
  const urns = ids.length ? await leadUrns([...new Set(ids)]) : new Map<string, string>();
  return {
    ...obj,
    [TASK_INTEGRATIONS_KEY]: integrations.map((i) => (Array.isArray(i?.teams)
      ? { ...i, teams: i.teams.map((t: StoredTeam) => ({ ...t, lead: urns.get(t.lead) ?? null })) }
      : i)),
  };
}
