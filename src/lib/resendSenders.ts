import { GraphQLError } from 'graphql';
import type { ResendSender } from '../generated/prisma/index.js';
import { lookupFailureOf, lookupResendDomainVerified } from './resendToolClient.js';
import { decryptToken, encryptToken } from './tokenCrypto.js';

export interface ResendCredentials {
  apiKey: string;
  from: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_API_KEY_LENGTH = 8_192;
const MAX_FROM_LENGTH = 320;

/** The address inside a sender identity: `Name <email>`, or a bare address. */
function addressOf(from: string): string {
  const angle = /<([^<>]+)>$/.exec(from);
  return (angle?.[1] ?? from).trim();
}

/** Validate and normalize `Name <email>` or a bare email address. */
export function normalizeResendFrom(raw: string): string {
  const from = raw.trim();
  if (from.length === 0 || from.length > MAX_FROM_LENGTH || /[\r\n]/.test(from)) {
    throw new GraphQLError(`from must be 1-${MAX_FROM_LENGTH} characters with no newlines.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  const email = addressOf(from);
  if (!EMAIL_RE.test(email)) {
    throw new GraphQLError('from must be an email address or Name <email@example.com>.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return from;
}

/** Validate and encrypt a write-only Resend API key. */
export function encryptResendApiKey(raw: string): string {
  const apiKey = raw.trim();
  if (apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) {
    throw new GraphQLError('apiKey must be one non-empty token without whitespace.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return encryptToken(apiKey);
}

/** Decrypt one org sender only at the internal capability-tool call boundary. */
export function decryptResendCredentials(
  row: Pick<ResendSender, 'apiKeyEncrypted' | 'fromAddress'>,
): ResendCredentials {
  return { apiKey: decryptToken(row.apiKeyEncrypted), from: row.fromAddress };
}

/**
 * #4865 — the domain a sender identity sends from, lowercased: the name Resend lists a domain
 * under, and so the one asked about. A stored `from` always carries an address, because
 * `normalizeResendFrom` admitted it.
 */
export function resendFromDomain(from: string): string {
  const address = addressOf(from);
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * #4865 — the state `ResendSender.domainVerified` reports, or null when it could not be read.
 *
 * Report only, and reads live: nothing is cached, so each call is one lookup with this sender's
 * own key (hrn:node:hadronmemory.com:specs:cor:int:030:01 — the capability tool calls Resend,
 * never core). A lookup that fails, runs past its bound, or has no tool configured is a missing
 * state, not an error in the sender read: it answers null and leaves one line that names the
 * class of failure and the HTTP status, never anything the tool said. Anything else — a stored
 * key that does not decrypt — is a fault, and is thrown.
 *
 * NOT a gate. The caller authorizes first, with the sender's own read gate; this spends the
 * org's key at the tool, exactly as the send path does.
 */
export async function resendSenderDomainVerified(
  row: Pick<ResendSender, 'fromAddress' | 'apiKeyEncrypted'>,
): Promise<boolean | null> {
  try {
    const { apiKey } = decryptResendCredentials(row);
    return await lookupResendDomainVerified(resendFromDomain(row.fromAddress), apiKey);
  } catch (err) {
    // Narrow on purpose: only the lookup's own typed failures are a missing state.
    const failure = lookupFailureOf(err);
    if (!failure) throw err;
    const { reason, status } = failure;
    // An unconfigured tool is a deployment state, not a failed lookup: null, and no line.
    if (reason !== 'not_configured') {
      console.warn(
        JSON.stringify({
          event: 'resend_domain_verified_unavailable',
          reason,
          ...(status === undefined ? {} : { status }),
        }),
      );
    }
    return null;
  }
}

/**
 * Platform fallback is operator-controlled and deny-by-default. IDs only:
 * the run already carries the canonical org PK, and accepting names/URNs here
 * would make an environment allowlist depend on mutable identifiers.
 */
export function isPlatformResendAllowed(organizationId: string): boolean {
  return new Set(
    (process.env.RESEND_PLATFORM_ORG_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ).has(organizationId);
}
