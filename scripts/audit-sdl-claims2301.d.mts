export const CLAIM_PATTERN: RegExp;
export function scanClaims(source: string): Array<{line: number; coord: string; text: string}>;
