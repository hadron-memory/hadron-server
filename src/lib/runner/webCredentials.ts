/**
 * Node-backed webfetch credentials (#628/#667).
 *
 * Credential nodes keep inspectable metadata in `data.webCredential` and an
 * AES-256-GCM ciphertext in the reserved `data.__webfetchAuthEncrypted` field:
 *
 *   {
 *     webCredential: { type: "bearer", urlPrefix: "https://api.example/v1/", keyId: "hadron-v1" },
 *     __webfetchAuthEncrypted: "<encryptToken(JSON.stringify(auth))>"
 *   }
 *
 * Only this module decrypts the auth object. The LLM supplies the node URN,
 * never credential material. The platform-held HADRON_ENCRYPTION_KEY is the
 * same small-secret envelope used by the other core registries.
 */
import { canReadMemory } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import { decryptToken } from '../tokenCrypto.js';
import { splitNodeUrn } from '../urn.js';
import type { WebFetchAuth } from '../webfetchClient.js';
import { resolveFlowMemory } from './loadFlowNode.js';
import type { RunToolContext } from './tools/types.js';

interface WebCredentialMetadata {
  type: WebFetchAuth['type'];
  urlPrefix: string;
  keyId?: string;
}

export interface ResolvedWebCredential {
  auth: WebFetchAuth;
  urlPrefix: string;
}

function principalAuth(ctx: RunToolContext): AuthContext {
  return {
    clientId: ctx.principal.clientId,
    userId: ctx.principal.userId,
    appId: ctx.principal.appId,
    organizationId: ctx.principal.organizationId,
  };
}

function isWebFetchAuth(value: unknown): value is WebFetchAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  switch (auth.type) {
    case 'bearer':
      return typeof auth.token === 'string' && auth.token.length > 0;
    case 'basic':
      return (
        typeof auth.username === 'string' &&
        typeof auth.password === 'string' &&
        auth.password.length > 0
      );
    case 'header':
      return (
        typeof auth.name === 'string' &&
        auth.name.length > 0 &&
        typeof auth.value === 'string' &&
        auth.value.length > 0
      );
    default:
      return false;
  }
}

/**
 * Origin-aware URL-prefix binding. A textual startsWith check is insufficient:
 * `https://api.example.evil/` must never satisfy `https://api.example/`.
 * Prefix query/fragment/userinfo are rejected because credential scope is an
 * origin + pathname concept, not a bearer hidden in the binding itself.
 */
export function assertUrlWithinPrefix(rawUrl: string, rawPrefix: string): void {
  let target: URL;
  let prefix: URL;
  try {
    target = new URL(rawUrl);
    prefix = new URL(rawPrefix);
  } catch {
    throw new Error('Web credential urlPrefix and poll URL must be absolute URLs.');
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
    throw new Error('Poll URL is outside the credential node urlPrefix.');
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
    throw new Error('Poll URL is outside the credential node urlPrefix.');
  }
}

/** Resolve, authorize, bind, and decrypt one credential node for a poll. */
export async function loadWebFetchCredential(
  ctx: RunToolContext,
  credentialsNodeUrn: string,
  pollUrl: string,
): Promise<ResolvedWebCredential> {
  const { memoryUrn, loc } = splitNodeUrn(credentialsNodeUrn);
  const memory = await resolveFlowMemory(
    ctx.db,
    memoryUrn,
    ctx.run.organizationId,
    credentialsNodeUrn,
  );
  // Preserve the shared read gate: knowing a same-org URN is not sufficient.
  if (!(await canReadMemory(ctx.db, principalAuth(ctx), memory.id))) {
    throw new Error('Credential memory is not readable under the run principal.');
  }
  const node = await ctx.db.node.findUnique({
    where: { loc_memoryId: { loc, memoryId: memory.id } },
    select: { data: true, deletedAt: true },
  });
  if (!node || node.deletedAt) throw new Error('Credential node was not found.');
  if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) {
    throw new Error('Credential node data is malformed.');
  }
  const data = node.data as Record<string, unknown>;
  const metadata = data.webCredential as WebCredentialMetadata | null;
  const ciphertext = data.__webfetchAuthEncrypted;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !['bearer', 'basic', 'header'].includes(metadata.type) ||
    typeof metadata.urlPrefix !== 'string' ||
    typeof ciphertext !== 'string'
  ) {
    throw new Error('Credential node data is malformed.');
  }
  assertUrlWithinPrefix(pollUrl, metadata.urlPrefix);

  let auth: unknown;
  try {
    auth = JSON.parse(decryptToken(ciphertext));
  } catch {
    throw new Error('Credential node secret could not be decrypted.');
  }
  if (!isWebFetchAuth(auth) || auth.type !== metadata.type) {
    throw new Error('Credential node secret does not match its declared type.');
  }
  return { auth, urlPrefix: metadata.urlPrefix };
}
