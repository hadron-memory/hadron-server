import { parsePolicyLink } from '@hadron-memory/access-control';

/** Parse the saved full-chain or legacy single-link run policy; an absent link imposes no restriction. */
export function parseRunPolicySnapshot(raw: unknown): Array<{ allow: string[] } | null> {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const chain = (raw as { chain?: unknown }).chain;
    if (Array.isArray(chain)) return chain.map((l) => parsePolicyLink(l));
  }
  return [parsePolicyLink(raw)];
}
