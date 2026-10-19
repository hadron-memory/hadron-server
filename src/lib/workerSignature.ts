/** #1602 / cor:agt:040:04: per-worker defaults hold variables, never resolved identity. */
import { GraphQLError } from 'graphql';
import { applyPlatformVariables, type PlatformVariableValues } from './personaDescription.js';
export const DEFAULT_WORKER_SIGNATURE = '— [{{worker.name}}, {{worker.role}}]({{worker.url}}) · {{session.llmModel}}';
export const DEFAULT_WORKER_TRAILER = 'Worker: {{worker.name}} ({{worker.role}}) <{{worker.url}}>';
export const WORKER_SIGNATURE_DEFAULTS = { signature: DEFAULT_WORKER_SIGNATURE, trailer: DEFAULT_WORKER_TRAILER } as const;
/** Engineering cap, initially 2000; changing it changes no wording policy. */
export const WORKER_SIGNATURE_MAX_CHARS = 2000;
export function normalizeWorkerSignature(value: unknown): string {
  if (typeof value !== 'string' || value.length > WORKER_SIGNATURE_MAX_CHARS || value.includes('\0')) {
    throw new GraphQLError('Signature and trailer must be text, at most 2000 characters, without NUL bytes; use an empty string to deliver nothing.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return value.trim() === '' ? '' : value;
}
/** Exactly one pass in each stored field. Signature/trailer self-references stay literal. */
export function withWorkerSignatures(values: PlatformVariableValues, stored: { signature: string; trailer: string }): PlatformVariableValues {
  const source = { ...values, 'worker.signature': '{{worker.signature}}', 'worker.trailer': '{{worker.trailer}}' };
  return { ...values, 'worker.signature': applyPlatformVariables(stored.signature, source), 'worker.trailer': applyPlatformVariables(stored.trailer, source) };
}
