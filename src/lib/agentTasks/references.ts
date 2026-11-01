/**
 * #2649 (hrn:node:hadronmemory.com:specs:cor:agt:050:01, References → Shape; :09 Editing): a task's ordered list of
 * typed references `{kind, target, label?}` to other things.
 *
 * The platform stores `target` exactly as given and checks only its FORM per kind. It never fetches, resolves or
 * interprets a target, so a reader learns the stored string and nothing else: not the target's content and not
 * whether it exists. Over a cap or a malformed target refuses the whole write (nothing is written).
 */
import { parseUrnV2 } from '@hadron-memory/urn-lib-js';

export const TASK_REFERENCE_KINDS = ['issue', 'pull_request', 'node', 'task', 'url'] as const;
export type TaskReferenceKind = typeof TASK_REFERENCE_KINDS[number];
export type TaskReference = { kind: TaskReferenceKind; target: string; label: string | null };

export const TASK_REFERENCES_MAX = 20;
export const TASK_REFERENCE_TARGET_MAX = 512;
export const TASK_REFERENCE_LABEL_MAX = 120;

/** GraphQL enum value ⇄ stored kind (the spec's lowercase words). */
export const REFERENCE_KIND_FROM_GQL: Record<string, TaskReferenceKind> = {
  ISSUE: 'issue', PULL_REQUEST: 'pull_request', NODE: 'node', TASK: 'task', URL: 'url',
};
export const REFERENCE_KIND_TO_GQL: Record<TaskReferenceKind, string> = {
  issue: 'ISSUE', pull_request: 'PULL_REQUEST', node: 'NODE', task: 'TASK', url: 'URL',
};

export class TaskReferenceError extends Error {}

/** The kind as stored: accepts the GraphQL enum value or the stored word; anything else is refused. */
export function referenceKind(raw: unknown): TaskReferenceKind {
  if (typeof raw === 'string') {
    // Own properties only: an inherited name (constructor, __proto__, toString) is not a kind.
    const kind = (Object.hasOwn(REFERENCE_KIND_FROM_GQL, raw) ? REFERENCE_KIND_FROM_GQL[raw] : undefined)
      ?? (TASK_REFERENCE_KINDS as readonly string[]).find(k => k === raw);
    if (kind) return kind as TaskReferenceKind;
  }
  throw new TaskReferenceError(`A reference kind is one of ${TASK_REFERENCE_KINDS.join(', ')}.`);
}

/**
 * The scheme, then `//`, then a non-empty authority, as written. The URL parser repairs `https:host`,
 * `https:///host` and backslashes into a valid URL; a target is stored as given, so those are refused here.
 */
const WRITTEN_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]/i;

function absoluteUrl(target: string, protocols: readonly string[]): boolean {
  if (target.includes('\\') || !WRITTEN_AUTHORITY.test(target)) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
  // http and https are special schemes: the parser already refuses an empty host.
  return protocols.includes(url.protocol);
}

function urnOfType(target: string, prefix: string, type: string): boolean {
  if (!target.startsWith(prefix)) return false;
  try {
    return parseUrnV2(target).type === type;
  } catch (e) {
    if (e instanceof Error) return false;
    throw e;
  }
}

/** Whether `target` has the form its kind requires (cor:agt:050:01). Never resolves it. */
export function targetHasKindForm(kind: TaskReferenceKind, target: string): boolean {
  switch (kind) {
    case 'issue':
    case 'pull_request': return absoluteUrl(target, ['https:']);
    case 'url': return absoluteUrl(target, ['http:', 'https:']);
    case 'node': return urnOfType(target, 'hrn:node:', 'node');
    // An agent-task URN in either leaf form (the task id, or the handle the qualified form carries); never a bare handle.
    case 'task': return urnOfType(target, 'hrn:agenttask:', 'agenttask');
  }
}

/**
 * The stored list for an input list: order kept, each item checked, caps applied. Null or an empty list is no
 * references. Refuses with a fixed message that names the item's position, never its text.
 */
export function normalizeTaskReferences(input: unknown): TaskReference[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TaskReferenceError('references must be a list.');
  if (input.length > TASK_REFERENCES_MAX) throw new TaskReferenceError(`A task has at most ${TASK_REFERENCES_MAX} references.`);
  return input.map((item, i): TaskReference => {
    const at = `Reference ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TaskReferenceError(`${at} must be an object of kind, target and label.`);
    const { kind: rawKind, target, label } = item as Record<string, unknown>;
    const kind = referenceKind(rawKind);
    if (typeof target !== 'string' || target.length === 0) throw new TaskReferenceError(`${at} needs a target.`);
    if (target.length > TASK_REFERENCE_TARGET_MAX) throw new TaskReferenceError(`${at}: a target is at most ${TASK_REFERENCE_TARGET_MAX} characters.`);
    // #3123 / hrn:node:hadronmemory.com:specs:cor:agt:050:01 (V27): format/direction characters can make a
    // stored reference show one link and lead to another. Check every kind and label before generic form checks.
    if (/\p{Cf}/u.test(target) || (typeof label === 'string' && /\p{Cf}/u.test(label))) {
      throw new TaskReferenceError(`${at}: a target or label may not contain an invisible format character.`);
    }
    // Judge userinfo in the written authority, not URL.username/password: https://@host has empty parsed fields.
    // @ in the path, query or fragment is ordinary target data and stays accepted. Never echo either input.
    if ((kind === 'issue' || kind === 'pull_request' || kind === 'url')
      && /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(target)?.[1].includes('@')) {
      throw new TaskReferenceError(`${at}: the target may not carry a user name or password.`);
    }
    // Stored as given, so a target the URL parser would silently trim or re-spell is refused, not rewritten.
    // Whitespace and control characters (C0 and DEL) are refused for every kind: the parser trims or encodes them.
    if (/[\s\x00-\x1f\x7f]/.test(target) || !targetHasKindForm(kind, target)) {
      throw new TaskReferenceError(`${at}: the target is not ${KIND_FORM[kind]}.`);
    }
    if (label != null && typeof label !== 'string') throw new TaskReferenceError(`${at}: a label is text.`);
    if (typeof label === 'string' && label.length > TASK_REFERENCE_LABEL_MAX) throw new TaskReferenceError(`${at}: a label is at most ${TASK_REFERENCE_LABEL_MAX} characters.`);
    return { kind, target, label: label ? label : null };
  });
}

const KIND_FORM: Record<TaskReferenceKind, string> = {
  issue: 'an absolute https URL',
  pull_request: 'an absolute https URL',
  node: 'a node URN (hrn:node:…)',
  task: 'an agent-task URN (hrn:agenttask:…)',
  url: 'an absolute http or https URL',
};

/** The stored column read back as the list (anything else reads as none; the CHECK keeps it an array). */
export function storedTaskReferences(value: unknown): TaskReference[] {
  return Array.isArray(value) ? (value as TaskReference[]) : [];
}

export const TASK_EXTERNAL_ID_MAX = 512;

/**
 * #3125 S2 (V46; hrn:node:hadronmemory.com:specs:cor:agt:120:02, Proposed): a task's external id, the claim on an
 * outside item. Stored exactly as given and compared exactly (a case variant is another id); never resolved or
 * fetched. 1 to 512 characters, with no whitespace, control (C0, DEL, C1) or format (Cf) character and, when written
 * as `scheme://authority`, no userinfo in the authority (the #3123 checks the references take). Null or undefined is
 * no external id. Refuses with fixed text that never echoes the value.
 */
export function normalizeExternalId(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== 'string') throw new TaskReferenceError('externalId is text.');
  checkExternalIdText(input);
  if (/[\s\p{Cc}\p{Cf}]/u.test(input)) {
    throw new TaskReferenceError('externalId may not contain whitespace, control or invisible format characters.');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(input)?.[1].includes('@') || parsesWithUserinfo(input)) {
    throw new TaskReferenceError('externalId may not carry a user name or password.');
  }
  return input;
}

/**
 * The checks an externalId and an `agentTasks(externalId:)` filter value share: 1 to 512 characters counted as the
 * database's char_length counts them (code points, so a supplementary character such as an emoji is one, not two
 * UTF-16 units), and no lone surrogate (not text Postgres can store; it would surface as an internal error).
 */
export function checkExternalIdText(input: string): void {
  if (/\p{Cs}/u.test(input)) {
    throw new TaskReferenceError('externalId may not contain an unpaired surrogate.');
  }
  let n = 0;
  for (const _ of input) if (++n > TASK_EXTERNAL_ID_MAX) break;
  if (n < 1 || n > TASK_EXTERNAL_ID_MAX) {
    throw new TaskReferenceError(`externalId must be 1 to ${TASK_EXTERNAL_ID_MAX} characters.`);
  }
}

/**
 * A malformed URL the WHATWG parser repairs into one that carries credentials (`https:///u:p@host/`,
 * `https:\\u:p@host/`, `https:/\u:p@host/`) slips past the `scheme://authority` pattern; refuse it by what it parses
 * to. A value that does not parse as a URL is an opaque id and passes.
 */
function parsesWithUserinfo(input: string): boolean {
  if (!URL.canParse(input)) return false;
  const u = new URL(input);
  return u.username !== '' || u.password !== '';
}
