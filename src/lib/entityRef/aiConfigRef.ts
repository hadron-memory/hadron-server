/**
 * The AI service config URN (#3857; cor:urn:010:01, V60-V63 as amended by
 * Holger's R3, 2026-11-10):
 *
 *   hrn:aiconf:<org>:org:<name>
 *   hrn:aiconf:<root>:app:<app-slug>:<name>
 *   hrn:aiconf:<author-root>:agent:<agent-slug>:<name>
 *   hrn:aiconf:server:<name>             HadronServer owner, reserved root
 *
 * COMPUTED, never stored (like a worker's): the owner's current URN plus the
 * config's name, which is unique per owner (cor:dmo:050:10). Consequences:
 *
 *   - an owner rename keeps an old URN resolving, because the owner part is
 *     looked up through `resolveOrgRef` / `resolveAppRef` / `resolveAgentRef`
 *     and their rename aliases; only the current spelling is emitted (V61);
 *   - a config rename re-addresses it with NO alias: the old URN then names
 *     whichever config of that owner now holds the old name, or nothing (V61);
 *   - a name `validateAiConfigName` accepts but the slug rule forbids (a
 *     trailing `-` or `_`) has no URN: `composeAiConfigUrn` returns null and
 *     logs (V62);
 *   - the kind word fixes the arity, so a URN parses without guessing, and a
 *     URN whose kind is not the config's owner kind names nothing (V60). A
 *     reserved root names its own owner, so no kind follows `server`.
 *
 * This module answers IDENTITY only. Every caller applies the config's read
 * gate afterwards (`readAiServiceConfigByUrn`), and an unreadable config must
 * answer as a missing one (V63).
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { composeUrnV2, parseUrnV2 } from '../urn.js';
import { emitEntityUrnV2 } from '../urnEmit.js';
import { resolveOrgRef } from './orgRef.js';
import { resolveAppRef } from './appRef.js';
import { resolveAgentRef } from './agentRef.js';
import { refNamesNothing } from './refNamesNothing.js';
import { currentHadronServerId } from '../hadronServer.js';

/** The reserved root a HadronServer-owned config lives under (R3). */
export const AICONF_SERVER_ROOT = 'server';

/** Who owns a config, with the owner's STORED bare urn where it has one. */
export type AiConfigUrnOwner =
  | { kind: 'server' }
  | { kind: 'org'; urn: string }
  | { kind: 'app'; urn: string }
  | { kind: 'agent'; urn: string };

/**
 * Compose the config's URN, or null when it cannot have one (a name that is not
 * a URN atom, or an owner whose stored urn is not the `<root>[:<slug>]` shape),
 * logging the reason. Never throws: it runs on a read path.
 */
export function composeAiConfigUrn(owner: AiConfigUrnOwner, name: string, warn: (msg: string) => void = console.warn): string | null {
  try {
    // Names are lower-case canonical (`validateAiConfigName`); parse looks the
    // name up EXACTLY, so a stored name that is not canonical must not emit a
    // URN that cannot resolve back to it.
    if (name !== name.toLowerCase()) throw new Error('name is not lower-case canonical');
    if (owner.kind === 'server') return composeUrnV2('aiconf', AICONF_SERVER_ROOT, name);
    const parsed = parseUrnV2(emitEntityUrnV2(owner.kind, owner.urn));
    if (owner.kind === 'org') {
      if (parsed.segments.length !== 0) throw new Error('org urn has a slug');
      return composeUrnV2('aiconf', parsed.root, 'org', name);
    }
    if (parsed.segments.length !== 1) throw new Error(`${owner.kind} urn is not <root>:<slug>`);
    return composeUrnV2('aiconf', parsed.root, owner.kind, parsed.segments[0]!, name);
  } catch (err) {
    warn(
      `[aiconf-urn] no URN for a ${owner.kind}-owned config named "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** A parsed `hrn:aiconf:` reference: the owner kind and its parts. */
export type ParsedAiConfigUrn =
  | { kind: 'server'; name: string }
  | { kind: 'org'; root: string; name: string }
  | { kind: 'app' | 'agent'; root: string; slug: string; name: string };

/**
 * Parse an `hrn:aiconf:` reference by its kind word. Roots and slugs go on to the
 * owner resolvers, which normalize them; the name is compared exactly. Null for anything that is
 * not one of the four shapes (wrong type word, unknown or missing kind, a kind
 * after the reserved root, wrong arity; a `#fragment` is already refused by the parser): such a URN names nothing.
 */
export function parseAiConfigUrn(ref: string): ParsedAiConfigUrn | null {
  let p: ReturnType<typeof parseUrnV2>;
  try {
    p = parseUrnV2((ref ?? '').trim());
  } catch {
    return null;
  }
  if (p.type !== 'aiconf') return null;
  const seg = p.segments;
  // The same rule as compose: a name is lower-case canonical or it is no URN atom,
  // so a config the platform cannot address by URN is not reachable by one either.
  if (seg.length === 0 || seg[seg.length - 1] !== seg[seg.length - 1]!.toLowerCase()) return null;
  if (p.root.toLowerCase() === AICONF_SERVER_ROOT) {
    return seg.length === 1 ? { kind: 'server', name: seg[0]! } : null;
  }
  if (seg[0] === 'org' && seg.length === 2) return { kind: 'org', root: p.root, name: seg[1]! };
  if ((seg[0] === 'app' || seg[0] === 'agent') && seg.length === 3) {
    return { kind: seg[0], root: p.root, slug: seg[1]!, name: seg[2]! };
  }
  return null;
}

type AiConfigRefDb = Pick<PrismaClient, 'aiServiceConfig' | 'organization' | 'app' | 'agent' | 'urnAlias' | 'hadronServer'>;

/**
 * Resolve an `hrn:aiconf:` URN to the config row, or null. IDENTITY only: no
 * read gate is applied here. An owner that names nothing, or a config the
 * owner does not hold, is null; any other failure is a fault and propagates.
 */
export async function resolveAiConfigByUrn(db: AiConfigRefDb, ref: string) {
  const parsed = parseAiConfigUrn(ref);
  if (!parsed) return null;
  try {
    switch (parsed.kind) {
      case 'server': {
        // `server` is THE SERVER ANSWERING (R3), not any HadronServer row: bind
        // to the current one, or two servers' `default` configs would share one URN.
        const serverId = await currentHadronServerId(db);
        if (!serverId) return null;
        return await db.aiServiceConfig.findFirst({ where: { hadronServerId: serverId, name: parsed.name } });
      }
      case 'org': {
        const { id } = await resolveOrgRef(db, composeUrnV2('org', parsed.root));
        return await db.aiServiceConfig.findFirst({ where: { organizationId: id, name: parsed.name } });
      }
      case 'app': {
        const { id } = await resolveAppRef(db, composeUrnV2('app', parsed.root, parsed.slug));
        return await db.aiServiceConfig.findFirst({ where: { appId: id, name: parsed.name } });
      }
      case 'agent': {
        const { id } = await resolveAgentRef(db, composeUrnV2('agent', parsed.root, parsed.slug));
        return await db.aiServiceConfig.findFirst({ where: { agentId: id, name: parsed.name } });
      }
    }
  } catch (error) {
    // Only a name-resolution outcome is the uniform "names nothing"; a fault
    // propagates (cor:api:260:01, #2975).
    if (!refNamesNothing(error, { ambiguousNamesNothing: true })) throw error;
    return null;
  }
}
