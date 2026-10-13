import { z } from 'zod';

/**
 * Zod record copying skips __proto__ before validating it. Returning original
 * JSON to preserve arbitrary keys therefore needs this own-entry check.
 * Schema discovery still uses the ordinary JSON Schema-compatible records.
 */
export function ownRecordIssues(schema: z.ZodRecord, input: unknown, path: PropertyKey[] = []): z.core.$ZodIssue[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const issues: z.core.$ZodIssue[] = [];
  for (const [key, value] of Object.entries(input)) {
    const keyResult = z.safeParse(schema.keyType, key);
    const valueResult = z.safeParse(schema.valueType, value);
    if (!keyResult.success) for (const issue of keyResult.error.issues) issues.push({ ...issue, path: [...path, key, ...issue.path] });
    if (!valueResult.success) for (const issue of valueResult.error.issues) issues.push({ ...issue, path: [...path, key, ...issue.path] });
    if (schema.valueType instanceof z.ZodRecord) issues.push(...ownRecordIssues(schema.valueType, value, [...path, key]));
  }
  return issues;
}
