/**
 * Secret-store run tool (#677) — the READ half of the read-vs-inject
 * contract: the resolved value is returned INTO the model context, an
 * exposure the agent author accepts by declaring the tool (same posture
 * as giving code access to a vault). Tools that touch untrusted external
 * content (web_poll_start, future fetch-shaped tools) must take a secret
 * NAME and let core inject server-side instead — never route through this.
 */
import { isModelReadableKind, SECRET_SCOPE_ORDER, type SecretOwnerType } from '../../secrets.js';
import { resolveRunSecret } from '../secrets.js';
import type { RunToolDef } from './types.js';

export const hadronReadSecret: RunToolDef = {
  name: 'hadron_read_secret',
  description:
    'Read a named secret from the Hadron secret store. The name resolves most-specific-first ' +
    '(memory, app, user, org) at scopes this run is entitled to; pass scope to pin one. ' +
    'The decrypted value is returned into your context — do not call this in a flow that also ' +
    'fetches untrusted external content; credentialed fetch tools take a secret name and ' +
    'inject it server-side instead. Inject-only kinds (e.g. webfetch-auth) are refused here.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The secret name (lowercase [a-z0-9-]).' },
      scope: {
        type: 'string',
        enum: [...SECRET_SCOPE_ORDER],
        description: 'Optional: resolve at exactly this scope instead of the cascade.',
      },
    },
    required: ['name'],
  },
  cost: 0,
  execute: async (ctx, args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) throw new Error('hadron_read_secret: "name" is required.');
    let scope: SecretOwnerType | undefined;
    if (args.scope != null) {
      if (
        typeof args.scope !== 'string' ||
        !(SECRET_SCOPE_ORDER as readonly string[]).includes(args.scope)
      ) {
        throw new Error(
          `hadron_read_secret: "scope" must be one of ${SECRET_SCOPE_ORDER.join(', ')}.`,
        );
      }
      scope = args.scope as SecretOwnerType;
    }
    const resolved = await resolveRunSecret(ctx, { name, scope });
    if (!resolved) {
      throw new Error(
        `hadron_read_secret: no secret named "${name}" is resolvable for this run${
          scope ? ` at scope "${scope}"` : ''
        }.`,
      );
    }
    // Enforce the read/inject split as a HARD per-kind lock: an inject-only
    // kind (e.g. webfetch-auth) must never reach model context, even when the
    // author declared this tool and the cascade resolved that name (a nearer
    // inject-only secret shadows a farther readable one loud, not silently).
    if (!isModelReadableKind(resolved.kind)) {
      throw new Error(
        `hadron_read_secret: secret "${name}" (kind "${resolved.kind}") is inject-only and cannot be read into context. ` +
          `Use it via the tool that injects it server-side (e.g. web_poll_start's credentialName).`,
      );
    }
    // Trail line carries name + winning scope only — never the value.
    ctx.log(`hadron_read_secret ${JSON.stringify({ name, scope: resolved.ownerType })}`);
    return {
      name: resolved.name,
      kind: resolved.kind,
      scope: resolved.ownerType,
      metadata: resolved.metadata,
      value: resolved.value,
    };
  },
};

export const SECRET_TOOLS: readonly RunToolDef[] = [hadronReadSecret];
