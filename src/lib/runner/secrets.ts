/**
 * Run-time secret resolution (#677) — the CSS cascade under the run
 * principal. A bare name resolves most-specific-first — user → org —
 * returning the first match the run is entitled to use. Entitlement is by
 * construction: the candidate owner IDs come from the run row itself.
 *
 * Owners are ORG/USER ONLY (#696, D-2026-07-15-006): the app- and
 * memory-owned scopes of the original #679 store are superseded (the flat v2
 * secret URN carries a single root principal). The #702 audit found 0
 * app/memory-owned rows.
 *
 * Both consumption models share this resolver and differ only in whether
 * the value reaches the model: `hadron_read_secret` RETURNS it (general
 * case, author-accepted exposure) while `web_poll_start` INJECTS it into
 * the capability-tool call server-side (mandatory for untrusted-content
 * tools — a model holding a secret while fetching attacker-controlled
 * pages is a live exfiltration target).
 *
 * Supersedes the #628 node-data credential scheme (`loadWebFetchCredential`).
 */
import {
  decryptSecretValue,
  isWebFetchAuth,
  SECRET_SCOPE_ORDER,
  type SecretOwnerType,
} from '../secrets.js';
import type { WebFetchAuth } from '../webfetchClient.js';
import type { RunToolContext } from './tools/types.js';

export interface ResolvedRunSecret {
  id: string;
  ownerType: SecretOwnerType;
  ownerId: string;
  name: string;
  kind: string;
  metadata: Record<string, unknown>;
  /** The decrypted payload. Callers decide read-vs-inject; never log it. */
  value: unknown;
}

/**
 * Resolve one secret name for this run via the cascade (optionally pinned
 * to a single scope). Returns the decrypted winner or null. A
 * more-specific match SHADOWS a less-specific one of the same name even
 * when its kind doesn't suit the caller — consumers assert kind on the
 * winner and fail loud rather than silently falling through (the cascade
 * contract stays predictable).
 */
export async function resolveRunSecret(
  ctx: RunToolContext,
  opts: { name: string; scope?: SecretOwnerType },
): Promise<ResolvedRunSecret | null> {
  const candidates: Array<{ ownerType: SecretOwnerType; ownerId: string }> = [];
  for (const scope of SECRET_SCOPE_ORDER) {
    if (opts.scope && opts.scope !== scope) continue;
    switch (scope) {
      case 'user':
        if (ctx.run.userId) candidates.push({ ownerType: 'user', ownerId: ctx.run.userId });
        break;
      case 'org':
        candidates.push({ ownerType: 'org', ownerId: ctx.run.organizationId });
        break;
    }
  }
  if (candidates.length === 0) return null;

  const rows = await ctx.db.secret.findMany({
    where: { name: opts.name, OR: candidates.map((c) => ({ ownerType: c.ownerType, ownerId: c.ownerId })) },
  });
  for (const c of candidates) {
    const row = rows.find((r) => r.ownerType === c.ownerType && r.ownerId === c.ownerId);
    if (!row) continue;
    return {
      id: row.id,
      ownerType: c.ownerType,
      ownerId: c.ownerId,
      name: row.name,
      kind: row.kind,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      value: decryptSecretValue(row),
    };
  }
  return null;
}

/**
 * Origin-aware URL-prefix binding. A textual startsWith check is
 * insufficient: `https://api.example.evil/` must never satisfy
 * `https://api.example/`. Prefix query/fragment/userinfo are rejected
 * because credential scope is an origin + pathname concept, not a bearer
 * hidden in the binding itself.
 */
export function assertUrlWithinPrefix(rawUrl: string, rawPrefix: string): void {
  let target: URL;
  let prefix: URL;
  try {
    target = new URL(rawUrl);
    prefix = new URL(rawPrefix);
  } catch {
    throw new Error('Web credential urlPrefix and target URL must be absolute URLs.');
  }
  if (
    !['http:', 'https:'].includes(prefix.protocol) ||
    prefix.username ||
    prefix.password ||
    prefix.search ||
    prefix.hash
  ) {
    throw new Error('Web credential urlPrefix must be an http(s) origin/path without userinfo, query, or fragment.');
  }
  if (target.origin !== prefix.origin) {
    throw new Error('Target URL is outside the secret urlPrefix.');
  }
  const prefixPath = prefix.pathname;
  const targetPath = target.pathname;
  const matchesPath =
    prefixPath === '/' ||
    targetPath === prefixPath ||
    (prefixPath.endsWith('/')
      ? targetPath.startsWith(prefixPath)
      : targetPath.startsWith(`${prefixPath}/`));
  if (!matchesPath) {
    throw new Error('Target URL is outside the secret urlPrefix.');
  }
}

export interface ResolvedWebFetchAuth {
  auth: WebFetchAuth;
  urlPrefix: string;
  /** Audit provenance for the poll's origin-run binding. */
  secretId: string;
}

/**
 * Resolve, kind-assert, origin-bind, and decrypt one webfetch-auth secret
 * for a poll — the INJECT path: the returned auth goes to the capability
 * tool, never to the model.
 */
export async function loadWebFetchAuthSecret(
  ctx: RunToolContext,
  name: string,
  scope: SecretOwnerType | undefined,
  targetUrl: string,
): Promise<ResolvedWebFetchAuth> {
  const resolved = await resolveRunSecret(ctx, { name, scope });
  if (!resolved) {
    throw new Error(
      `No secret named "${name}" is resolvable for this run${scope ? ` at scope "${scope}"` : ''}.`,
    );
  }
  if (resolved.kind !== 'webfetch-auth') {
    throw new Error(
      `Secret "${name}" (scope ${resolved.ownerType}) has kind "${resolved.kind}", not "webfetch-auth".`,
    );
  }
  const urlPrefix = resolved.metadata.urlPrefix;
  if (typeof urlPrefix !== 'string') {
    throw new Error(`Secret "${name}" is malformed: missing metadata.urlPrefix.`);
  }
  assertUrlWithinPrefix(targetUrl, urlPrefix);
  const auth = resolved.value;
  if (!isWebFetchAuth(auth) || auth.type !== resolved.metadata.type) {
    throw new Error(`Secret "${name}" payload does not match its declared type.`);
  }
  return { auth, urlPrefix, secretId: resolved.id };
}
