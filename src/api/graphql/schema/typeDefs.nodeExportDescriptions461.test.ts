/**
 * #461 — `NodeExportResult.data` and `.bytes` describe BOTH encodings. `NodeExportEncoding` is TEXT or BASE64 (a PDF export
 * carries base64), so a description that says "(TEXT)" or "(UTF-8)" misleads a consumer who reads only the field.
 * Docs-only: the resolver (`resolvers.query.node.ts`, the export branch) is unchanged. For BASE64 the byte count is the
 * renderer's reported size of the PDF, falling back to the decoded length of the base64 payload (`pdfClient.ts`); it is
 * never the length of the base64 string.
 */
import { describe, expect, it } from 'vitest';
import { Kind, parse, type FieldDefinitionNode, type ObjectTypeDefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';

function fieldDescription(field: string): string {
  const doc = parse(typeDefs);
  const type = doc.definitions.find(
    (d): d is ObjectTypeDefinitionNode => d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === 'NodeExportResult',
  );
  const f = type?.fields?.find((x): x is FieldDefinitionNode => x.name.value === field);
  return f?.description?.value ?? '';
}

describe('#461 NodeExportResult descriptions state both encodings', () => {
  it('data: names TEXT and BASE64 and points at `encoding`', () => {
    const d = fieldDescription('data');
    expect(d).toContain('TEXT');
    expect(d).toContain('BASE64');
    expect(d).toContain('encoding');
  });

  it('data: no longer calls the contents text-only', () => {
    expect(fieldDescription('data')).not.toBe('The rendered file contents (TEXT).');
  });

  it('bytes: says what is counted per encoding, and that BASE64 is not the length of the base64 string', () => {
    const b = fieldDescription('bytes');
    expect(b).toContain('TEXT');
    expect(b).toContain('BASE64');
    expect(b).toMatch(/not the length of the base64 string/i);
  });

  it('bytes: no longer says UTF-8 for every encoding', () => {
    expect(fieldDescription('bytes')).not.toBe('Byte length of the rendered payload (UTF-8).');
  });
});
