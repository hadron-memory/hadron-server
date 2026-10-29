/**
 * #2712 (Holger, 2026-10-28, D3: "I want the old systemPrompt to be deleted") —
 * `Agent.systemPrompt`, `App.systemPrompt` and `Worker.promptOverride` are gone:
 * every boot prompt is served from a compiled, approved node (cor:agt:040:07 "no
 * literal fallback", cor:dmo:050:01), and a new Agent starts with no prompt
 * (Vera's ruling on item 5, cor:agt:040:10/:12).
 *
 * The SDL is the contract every client shares, so the pins read it: no field,
 * no argument, no input field, and a request that still passes one is refused by
 * GraphQL validation rather than accepted and ignored. The last pin scans the
 * server's own sources, the issue's "no source reference remains outside the
 * migration and history".
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, parse, validate, GraphQLObjectType, GraphQLInputObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

const schema = buildSchema(typeDefs);

describe('#2712 — the retired prompt fields are gone from the SDL', () => {
  it.each([
    ['Agent', 'systemPrompt'],
    ['App', 'systemPrompt'],
    ['Worker', 'promptOverride'],
  ])('%s has no %s field', (type, field) => {
    const t = schema.getType(type) as GraphQLObjectType;
    expect(Object.keys(t.getFields())).not.toContain(field);
  });

  it.each([
    ['createAgent', 'systemPrompt'],
    ['updateAgent', 'systemPrompt'],
    ['createApp', 'systemPrompt'],
    ['updateApp', 'systemPrompt'],
    ['castWorker', 'promptOverride'],
    ['updateWorker', 'promptOverride'],
  ])('Mutation.%s takes no %s argument', (mutation, arg) => {
    const field = schema.getMutationType()!.getFields()[mutation];
    expect(field).toBeDefined();
    expect(field.args.map((a) => a.name)).not.toContain(arg);
  });

  it('Query.castWorkerPreview takes no promptOverride argument', () => {
    const field = schema.getQueryType()!.getFields().castWorkerPreview;
    expect(field.args.map((a) => a.name)).not.toContain('promptOverride');
  });

  it('no input type carries either field', () => {
    const carriers = Object.values(schema.getTypeMap())
      .filter((t): t is GraphQLInputObjectType => t instanceof GraphQLInputObjectType)
      .filter((t) => Object.keys(t.getFields()).some((f) => f === 'systemPrompt' || f === 'promptOverride'))
      .map((t) => t.name);
    expect(carriers).toEqual([]);
  });

  it.each([
    ['createAgent', 'mutation { createAgent(name: "a", systemPrompt: "x") { id } }', 'systemPrompt'],
    ['updateAgent', 'mutation { updateAgent(ref: "a", systemPrompt: "x") { id } }', 'systemPrompt'],
    ['updateApp', 'mutation { updateApp(ref: "a", systemPrompt: "x") { id } }', 'systemPrompt'],
    ['updateWorker', 'mutation { updateWorker(workerRef: "w", promptOverride: "x") { id } }', 'promptOverride'],
  ])('%s with the removed argument is refused, not accepted and ignored', (mutation, doc, arg) => {
    const errors = validate(schema, parse(doc));
    expect(errors.map((e) => e.message)).toContain(`Unknown argument "${arg}" on field "Mutation.${mutation}".`);
  });
});

/** Source files under `dir`, skipping tests, the diagnostics probes and generated output. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|mjs|js)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

describe('#2712 — no source reference remains outside the migrations and history', () => {
  it('src/, scripts/ and the Prisma schema never name the retired fields or columns', () => {
    const files = [...sources('src'), ...sources('scripts'), 'prisma/schema.prisma'];
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/systemPrompt|promptOverride|system_prompt|prompt_override/.test(line) ? [`${file}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});

// D1 (Holger, 2026-10-29, "Yes, retire it", decisions:2026-10-29-holger-rulings-to-vera): the serving switch is retired
// with the literal prompts it fell back to, so a boot prompt is always the served compiled node.
describe('#2712 D1 — BOOT_PROMPT_SERVE_ENABLED is retired', () => {
  it('the gate module is gone and no source or document names the switch', () => {
    expect(existsSync('src/lib/bootPrompt/gate.ts')).toBe(false);
    const files = [...sources('src'), ...sources('scripts'), 'CLAUDE.md'];
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/BOOT_PROMPT_SERVE_ENABLED|bootPromptServingEnabled/.test(line) ? [`${file}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
