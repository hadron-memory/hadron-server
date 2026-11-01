/**
 * #2831 S1 (cor:agt:060:12) — model groups: an opaque name over a list of model patterns, declared by the team
 * Agent and overridable by the App, resolved LIVE at read time (V16, never copied at install, never read from a
 * published revision). The platform gives a group's name and members no meaning; a group is a matching input,
 * never an authorization input.
 *
 * The walk: for each name, the App's group if it has one, else the Team Agent's. An App-only group has no Agent
 * counterpart. An App override with an empty list stays an override (it matches no one). There is no merge.
 */

import type { Prisma } from '../../generated/prisma/index.js';

/** Where an effective group comes from (cor:agt:060:12): the Agent's, an App's replacement of it, or the App's own. */
export type ModelGroupOrigin = 'AGENT' | 'APP_OVERRIDE' | 'APP';

export type EffectiveModelGroup = { name: string; patterns: string[]; origin: ModelGroupOrigin };

export const MODEL_GROUP_NAME_MAX = 64;
export const MODEL_GROUP_PATTERNS_MAX = 100;
export const MODEL_GROUP_PATTERN_MAX = 128;
/** Most groups one owner (an Agent, or an App) declares. */
export const MODEL_GROUPS_PER_OWNER_MAX = 50;

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PATTERN_RE = /^[a-z0-9._:/@*?-]+$/;

/** The canonical (lowercase) group name, or null when it is not a token of letters, digits, ".", "_" or "-". */
export function normalizeModelGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return name.length >= 1 && name.length <= MODEL_GROUP_NAME_MAX && NAME_RE.test(name) ? name : null;
}

/**
 * The canonical pattern list (lowercase, de-duplicated, first-seen order), or a message saying what is wrong.
 * `*` matches any run of characters and `?` one; nothing else is special. An empty list is allowed: an override
 * with no patterns matches no one.
 */
export function normalizeModelPatterns(raw: unknown): { patterns: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'patterns is a list of model patterns.' };
  if (raw.length > MODEL_GROUP_PATTERNS_MAX) {
    return { error: `A group holds at most ${MODEL_GROUP_PATTERNS_MAX} patterns.` };
  }
  const out: string[] = [];
  for (const p of raw) {
    const v = typeof p === 'string' ? p.trim().toLowerCase() : '';
    if (v.length < 1 || v.length > MODEL_GROUP_PATTERN_MAX || !PATTERN_RE.test(v)) {
      return {
        error:
          `A pattern is 1 to ${MODEL_GROUP_PATTERN_MAX} characters of letters, digits and . _ : / @ -, ` +
          'where * stands for any run of characters and ? for one, e.g. claude-opus-*.',
      };
    }
    if (!out.includes(v)) out.push(v);
  }
  return { patterns: out };
}

/**
 * The effective groups of an App: the Team Agent's groups with the App's overrides applied by name, plus the
 * App-only groups, ordered by name. `teamAgentId` is the Team Agent, or null when the App has none (then only the
 * App's own groups exist). Live: it reads the rows as they are now.
 */
export async function effectiveModelGroups(
  db: Pick<Prisma.TransactionClient, 'modelGroup'>,
  appId: string,
  teamAgentId: string | null,
): Promise<EffectiveModelGroup[]> {
  const [agentRows, appRows] = await Promise.all([
    teamAgentId ? db.modelGroup.findMany({ where: { agentId: teamAgentId } }) : Promise.resolve([]),
    db.modelGroup.findMany({ where: { appId } }),
  ]);
  const byName = new Map<string, EffectiveModelGroup>();
  for (const r of agentRows) byName.set(r.name, { name: r.name, patterns: r.patterns, origin: 'AGENT' });
  for (const r of appRows) {
    byName.set(r.name, { name: r.name, patterns: r.patterns, origin: byName.has(r.name) ? 'APP_OVERRIDE' : 'APP' });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The pure glob primitive (#2831 S2): full-string, case-insensitive, `*` (any run) and `?` (one char) only. Iterative
 * two-pointer match that remembers only the LAST star, so it is O(pattern x model) in the worst case and never
 * backtracks exponentially: a manager-written pattern of separated stars cannot slow a matching pass (BLIND and LOCAL
 * review of the first head, where a regex expansion took over a second on a 41-character legal pattern).
 */
export function modelMatchesPattern(pattern: string, model: string): boolean {
  const p = pattern.toLowerCase();
  const s = model.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < s.length) {
    // The star is judged FIRST: a model may itself contain a literal `*` (or `?`), and a pattern's `*` is always a
    // wildcard, never a literal to be equality-matched against that character.
    if (i < p.length && p[i] === '*') {
      star = i++;
      mark = j;
    } else if (i < p.length && (p[i] === '?' || p[i] === s[j])) {
      i++;
      j++;
    } else if (star !== -1) {
      i = star + 1;
      j = ++mark;
    } else {
      return false;
    }
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

/** Is `model` in the named group? No model, or a name no group carries, is in nothing. */
export function modelInGroup(groups: EffectiveModelGroup[], name: string, model: string | null): boolean {
  if (!model) return false;
  const g = groups.find((x) => x.name === name);
  return !!g && g.patterns.some((p) => modelMatchesPattern(p, model));
}

/** The group requirements of a task, judged on one worker's model: In admits on any one, NotIn refuses on any one. */
export function modelGroupsAllowed(
  req: { modelGroupIn?: string[]; modelGroupNotIn?: string[] },
  model: string | null,
  groups: EffectiveModelGroup[],
): boolean {
  if (req.modelGroupIn && !req.modelGroupIn.some((n) => modelInGroup(groups, n, model))) return false;
  if (req.modelGroupNotIn && req.modelGroupNotIn.some((n) => modelInGroup(groups, n, model))) return false;
  return true;
}
