/**
 * #2510 — a type-level description sits directly above the type it describes. A later declaration inserted
 * between a description and its type moved three descriptions onto the wrong type (TeamTagSnapshot,
 * WorkerTeamPlacement, AppRunFailureReason) and left their owners bare. Read from the parsed SDL, so the
 * check follows what introspection and codegen see, not the text layout.
 */

import { describe, expect, it } from 'vitest';
import { parse, type DefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';

const flat = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

const definitions = parse(typeDefs).definitions;
const descriptionOf = (name: string): string => {
  const def = definitions.find(
    (d): d is DefinitionNode & { name: { value: string }; description?: { value: string } } =>
      'name' in d && (d.name as { value: string } | undefined)?.value === name,
  );
  expect(def, `${name} must exist`).toBeDefined();
  return flat(def?.description?.value);
};

describe('#2510 type-level descriptions are attached to the type they describe', () => {
  it.each([
    ['TeamChatMessage', "One message in a team App's chat"],
    ['CastWorkerPreview', 'What castWorker WOULD do'],
    ['AppRun', 'One headless run'],
  ])('%s carries its own description', (name, start) => {
    expect(descriptionOf(name).startsWith(start)).toBe(true);
  });

  it.each(['TeamTagSnapshot', 'WorkerTeamPlacement', 'AppRunFailureReason'])(
    '%s carries no description borrowed from a neighbouring type',
    (name) => {
      expect(descriptionOf(name)).toBe('');
    },
  );
});
