/**
 * #4875: `secret_events.seq` is a bigint and `JSON.stringify` refuses one. The canary scans stringify whole event rows to prove no
 * value is in any column, so they pass this replacer and still read every column (the bigint becomes its decimal string).
 */
export const bigintAsString = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value);
