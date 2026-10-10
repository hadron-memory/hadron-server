import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { ownRecordIssues } from './recordEntries.js';

export const TEAM_API_VERSION = 'hadron.dev/team/v1alpha1';
export type TeamSpecForm = 'SERVER' | 'CLIENT_INPUT';
const annotations = z.record(z.string(), z.string());
const ref = z.string().min(1);
const slug = z.string().regex(/^[a-z0-9-]+$/);
const nodePart = z.strictObject({
  node: ref,
  revision: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const textPart = z.strictObject({ text: z.string() });
const filePart = z.strictObject({ file: ref });
const resolved = z.union([
  z.strictObject({ adopt: ref }),
  z.strictObject({ create: z.strictObject({ urn: ref }) }),
]);

/** AM: no removal verbs, shared-agent update opt-in or fork in either form. */
export function teamSpecSchema(form: TeamSpecForm = 'SERVER') {
  const parts = form === 'CLIENT_INPUT'
    ? z.union([textPart, nodePart, filePart]) : z.union([textPart, nodePart]);
  const common = {
    title: z.string().optional(),
    visibility: z.enum(['PUBLIC', 'ORGANIZATION', 'PERSONAL']).optional(),
    registerDefaults: z.strictObject({ mentionOnly: z.boolean().optional() }).optional(),
    resolved: resolved.optional(),
  };
  const role = z.union([
    z.strictObject({ ...common, agent: ref }),
    z.strictObject({ ...common, prompt: z.strictObject({ parts: z.array(parts).min(1) }) }),
  ]);
  return z.strictObject({
    apiVersion: z.literal(TEAM_API_VERSION),
    kind: z.literal('Team'),
    metadata: z.strictObject({ app: ref, org: ref.optional(), annotations: annotations.optional() }),
    spec: z.strictObject({
      roles: z.record(slug, role),
      workers: z.array(z.strictObject({
        name: z.string().min(1), role: slug,
        override: z.string().nullable().optional(),
        annotations: annotations.optional(),
        register: z.strictObject({ channel: z.literal('default'), mentionOnly: z.boolean() }).optional(),
      })),
    }),
  });
}
export type TeamSpec = z.infer<ReturnType<typeof teamSpecSchema>>;
export type TeamSpecIssue = { pointer: string; code: string; message: string };
export const pointer = (path: PropertyKey[]) => path.length === 0 ? ''
  : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

export function unsupportedVersion(apiVersion: string): never {
  throw new GraphQLError('Unsupported team spec version', { extensions: {
    code: 'TEAM_SPEC_VERSION_UNSUPPORTED', apiVersion, accepted: [TEAM_API_VERSION],
  } });
}
export function publishedTeamSpecSchema(apiVersion: string, form: TeamSpecForm = 'SERVER') {
  if (apiVersion !== TEAM_API_VERSION) unsupportedVersion(apiVersion);
  return z.toJSONSchema(teamSpecSchema(form), { target: 'draft-2020-12' });
}
const schemaTexts = new Map<TeamSpecForm, string>();
/** Immutable serialized discovery documents; build once per form. */
export function publishedTeamSpecSchemaText(apiVersion: string, form: TeamSpecForm = 'SERVER'): string {
  if (apiVersion !== TEAM_API_VERSION) unsupportedVersion(apiVersion);
  if (!schemaTexts.has(form)) schemaTexts.set(form, JSON.stringify(publishedTeamSpecSchema(apiVersion, form)));
  return schemaTexts.get(form)!;
}

/** Validation keeps text and absent/null values intact; sources resolve in S2. */
export function validateTeamSpec(input: unknown, form: TeamSpecForm = 'SERVER'): TeamSpec {
  if (input && typeof input === 'object' && 'apiVersion' in input
      && typeof input.apiVersion === 'string' && input.apiVersion !== TEAM_API_VERSION) {
    unsupportedVersion(input.apiVersion);
  }
  const definition = teamSpecSchema(form);
  const parsed = definition.safeParse(input);
  if (!parsed.success) throw new GraphQLError('Invalid team spec', { extensions: {
    code: 'TEAM_SPEC_INVALID', issues: parsed.error.issues.map((i) => ({
      pointer: pointer(i.path), code: i.code, message: i.message,
    })),
  } });
  // No transforms/defaults are present. Preserve the accepted input itself:
  // annotations permit every JSON key, including keys a schema library may
  // otherwise omit while copying a record (e.g. __proto__).
  const spec = input as TeamSpec;
  const recordIssues = [
    ...ownRecordIssues(definition.shape.spec.shape.roles, spec.spec.roles, ['spec', 'roles']),
    ...ownRecordIssues(annotations, spec.metadata.annotations, ['metadata', 'annotations']),
    ...spec.spec.workers.flatMap((worker, i) => ownRecordIssues(annotations, worker.annotations, ['spec', 'workers', i, 'annotations'])),
  ];
  if (recordIssues.length) throw new GraphQLError('Invalid team spec', { extensions: {
    code: 'TEAM_SPEC_INVALID', issues: recordIssues.map((i) => ({ pointer: pointer(i.path), code: i.code, message: i.message })),
  } });
  const issues: TeamSpecIssue[] = [];
  const seen = new Set<string>();
  spec.spec.workers.forEach((worker, i) => {
    const name = worker.name.trim().toLowerCase();
    if (!name) issues.push({ pointer: `/spec/workers/${i}/name`, code: 'TEAM_SPEC_INVALID', message: 'Name must not be blank' });
    if (seen.has(name)) issues.push({ pointer: `/spec/workers/${i}/name`, code: 'TEAM_SPEC_DUPLICATE_WORKER', message: 'Worker names must be unique ignoring case and surrounding whitespace' });
    seen.add(name);
    if (!Object.hasOwn(spec.spec.roles, worker.role)) issues.push({ pointer: `/spec/workers/${i}/role`, code: 'TEAM_SPEC_UNKNOWN_ROLE', message: 'Role must be declared in spec.roles' });
  });
  for (const [key, role] of Object.entries(spec.spec.roles)) {
    if (!('prompt' in role)) continue;
    role.prompt.parts.forEach((part, i) => {
      if ('node' in part && part.sha256 && !part.revision) issues.push({
        pointer: pointer(['spec', 'roles', key, 'prompt', 'parts', i, 'sha256']),
        code: 'TEAM_SPEC_INVALID', message: 'A source hash requires a revision pin',
      });
    });
  }
  if (issues.length) throw new GraphQLError('Invalid team spec', { extensions: { code: 'TEAM_SPEC_INVALID', issues } });
  return spec;
}
