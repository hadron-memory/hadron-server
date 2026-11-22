export const DEFAULT_ENTRY: string;
export const DEFAULT_MANIFEST: string;
export const ALLOWED_PACKAGES: Set<string>;
export const REGENERATE_COMMAND: string;
export const MANIFEST_HEADER: string[];
export function importsOf(
  fileName: string,
  text: string,
): Array<{ specifier: string } | { dynamic: true; line: number } | { syntax: true; line: number }>;
export function resolveSpecifier(fromFile: string, specifier: string): string | undefined;
export function computeClosure(args: { root: string; entry: string }): { files: string[]; errors: string[] };
export function renderManifest(files: string[]): string;
export function parseManifest(text: string): string[];
export function compare(files: string[], manifestText: string): string[];
