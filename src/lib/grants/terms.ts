/**
 * #3649 slice A (cor:acl:140:09, "The terms document"): the canonical bytes of a grant's terms and their SHA-256, the
 * terms hash a grant signature payload binds. Pure: no database, no clock, no locale. A verifier rebuilds these bytes
 * byte for byte, so every rule below is a refusal, never a repair: a value that does not fit is refused, not trimmed,
 * re-encoded, case-folded, rounded or sorted into shape.
 *
 *   hadron-grant-terms-v1
 *   app <App id>
 *   holder <user|agent|worker|app> <holder id>
 *   action <action name>
 *   values <RFC 8785 JSON object>
 *   starts <YYYY-MM-DDTHH:MM:SS.sssZ | none>
 *   expires <YYYY-MM-DDTHH:MM:SS.sssZ | none>
 *   max-uses <decimal, no sign, no leading zero | none>
 *   reason <RFC 8785 JSON string>
 *
 * UTF-8, LF after every line including the last. Ids, the action name and values keys are visible ASCII; the value
 * domain is strings, the wildcard `*` and lists of strings (the section 10 byte review, #3649 comment 6746226903). The
 * bytes are pinned by the conformance fixture
 * (`grantSignature.fixture.json`, generated independently with Python). A different terms document is a new first line
 * and a new fixture, never a change to this one.
 */
import { createHash } from 'node:crypto';
import { canonicalizeTeamJson } from '../teamSpec/canonicalize.js';

export const GRANT_TERMS_V1 = 'hadron-grant-terms-v1';

export const GRANT_HOLDER_KINDS = ['user', 'agent', 'worker', 'app'] as const;
export type GrantHolderKind = (typeof GRANT_HOLDER_KINDS)[number];

/** The wildcard value: the JSON string `*`, the form `summary.ts` already refuses to render. */
export const GRANT_WILDCARD = '*';

export type GrantTermsReason =
  | 'BAD_TOKEN' | 'BAD_HOLDER' | 'BAD_VALUES' | 'BAD_TIME' | 'BAD_COUNT' | 'BAD_REASON';

/** The terms cannot be written as `hadron-grant-terms-v1`. The message names the term, never its value. */
export class GrantTermsError extends Error {
  readonly code = 'GRANT_TERMS_UNREPRESENTABLE' as const;
  constructor(readonly reason: GrantTermsReason, message: string) {
    super(message);
    this.name = 'GrantTermsError';
  }
}

export interface GrantTerms {
  appId: string;
  holder: { kind: GrantHolderKind; id: string };
  action: string;
  values: unknown;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  reason: string;
}

/** The grant row's columns the terms are read from (`model Grant`). */
export interface GrantTermsRow {
  appId: string;
  userId: string | null;
  agentId: string | null;
  workerId: string | null;
  granteeAppId: string | null;
  action: string;
  values: unknown;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  reason: string;
}

/**
 * A token (an id or the action name): one or more characters of U+0021..U+007E, written exactly as stored. An
 * allowlist, not Unicode property sets, because those differ between runtimes' Unicode versions; it also rules out
 * every way to end, split or visually forge a line (the section 10 byte review, P8, #3649 comment 6746226903). Every
 * id the platform mints fits: cuids, 32-hex ids, base64url request ids and dotted action names.
 */
const TOKEN_RE = /^[\x21-\x7e]+$/;
/** One token of `hadron-grant-terms-v1` and `hadron-grant-signature-v1` (the same rule in both documents). */
export function isGrantToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * A values key: a token without `"` or `\` (P4a). RFC 8785 sorts keys by UTF-16 code unit and some implementations by
 * code point; the two orders agree on ASCII, so every verifier writes the same line.
 */
const KEY_RE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
function token(term: string, value: unknown): string {
  if (!isGrantToken(value)) {
    throw new GrantTermsError('BAD_TOKEN', `grant terms: ${term} must be one token`);
  }
  return value;
}

/** No lone surrogate: such a string has no UTF-8 encoding, so its bytes would not be the bytes a verifier rebuilds. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** The holder line's kind from the row's four exclusive holder columns (chk_grants_exactly_one_holder). */
export function grantTermsFromRow(row: GrantTermsRow): GrantTerms {
  const holders = ([
    ['user', row.userId], ['agent', row.agentId], ['worker', row.workerId], ['app', row.granteeAppId],
  ] as const).filter(([, id]) => id !== null);
  if (holders.length !== 1) throw new GrantTermsError('BAD_HOLDER', 'grant terms: exactly one holder is required');
  const [[kind, id]] = holders;
  return {
    appId: row.appId, holder: { kind, id: id! }, action: row.action, values: row.values,
    startsAt: row.startsAt, expiresAt: row.expiresAt, maxUses: row.maxUses, reason: row.reason,
  };
}

/**
 * One parameter's value (P1-P4): a non-empty string (an id, a node-ref as its stored node id, never a URN, or the
 * wildcard `*` as the whole value), or a non-empty list of distinct elements in stored order, each element a non-empty
 * string that is not `*`. In v1 `*` always means the wildcard; an action needing a literal `*` needs terms v2. Anything
 * else is refused: numbers (whose RFC 8785 form implementations disagree on), booleans, null, nested objects or lists,
 * the empty string and a lone surrogate.
 */
function checkValue(value: unknown): void {
  const str = (v: unknown): v is string => typeof v === 'string' && v !== '' && wellFormed(v);
  if (str(value)) return;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => str(v) && v !== GRANT_WILDCARD)
    && new Set(value).size === value.length) return;
  throw new GrantTermsError('BAD_VALUES', 'grant terms: a value must be a string, the wildcard, or a list of distinct strings');
}

function valuesLine(values: unknown): string {
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || (Object.getPrototypeOf(values) !== Object.prototype && Object.getPrototypeOf(values) !== null)) {
    throw new GrantTermsError('BAD_VALUES', 'grant terms: values must be a JSON object');
  }
  for (const key of Object.keys(values)) {
    if (!KEY_RE.test(key)) throw new GrantTermsError('BAD_VALUES', 'grant terms: a value key must be visible ASCII without a quote or backslash');
    const d = Object.getOwnPropertyDescriptor(values, key)!;
    if (!('value' in d)) throw new GrantTermsError('BAD_VALUES', 'grant terms: values must be plain data');
    checkValue(d.value);
  }
  // Every string is well formed and every value plain data, so the RFC 8785 encoder cannot refuse here.
  return canonicalizeTeamJson(values);
}

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, or `none`. A time outside years 0000-9999 has no such form and is refused. */
function timeLine(term: string, t: Date | null): string {
  if (t === null) return 'none';
  const iso = t instanceof Date && Number.isFinite(t.getTime()) ? t.toISOString() : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) {
    throw new GrantTermsError('BAD_TIME', `grant terms: ${term} cannot be written as YYYY-MM-DDTHH:MM:SS.sssZ`);
  }
  return iso;
}

function countLine(n: number | null): string {
  if (n === null) return 'none';
  if (!Number.isSafeInteger(n) || n < 1) throw new GrantTermsError('BAD_COUNT', 'grant terms: max-uses must be a positive integer');
  return String(n);
}

/**
 * The reason exactly as stored, as an RFC 8785 JSON string. Refused only where the row could not hold it: the DB's
 * `btrim(reason) <> ''` trims spaces alone, so this does too (a JS `trim()` would refuse a storable tab-only reason and
 * leave that grant unsignable).
 */
function reasonLine(reason: unknown): string {
  if (typeof reason !== 'string' || /^ *$/.test(reason) || !wellFormed(reason)) {
    throw new GrantTermsError('BAD_REASON', 'grant terms: reason must be non-empty text');
  }
  return canonicalizeTeamJson(reason);
}

/** The exact `hadron-grant-terms-v1` bytes (cor:acl:140:09). Every line is judged before any is written. */
export function grantTermsBytes(terms: GrantTerms): Buffer {
  if (!terms.holder || !(GRANT_HOLDER_KINDS as readonly string[]).includes(terms.holder.kind)) {
    throw new GrantTermsError('BAD_HOLDER', 'grant terms: holder kind must be user, agent, worker or app');
  }
  const lines = [
    GRANT_TERMS_V1,
    `app ${token('app', terms.appId)}`,
    `holder ${terms.holder.kind} ${token('holder id', terms.holder.id)}`,
    `action ${token('action', terms.action)}`,
    `values ${valuesLine(terms.values)}`,
    `starts ${timeLine('starts', terms.startsAt)}`,
    `expires ${timeLine('expires', terms.expiresAt)}`,
    `max-uses ${countLine(terms.maxUses)}`,
    `reason ${reasonLine(terms.reason)}`,
  ];
  return Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8');
}

/** The terms hash: SHA-256 of the terms bytes, as 64 lowercase hex. */
export function grantTermsHash(terms: GrantTerms): string {
  return createHash('sha256').update(grantTermsBytes(terms)).digest('hex');
}
