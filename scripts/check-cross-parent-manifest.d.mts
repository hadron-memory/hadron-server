export const MANIFEST_PATH: string;
export const CLASSES: readonly string[];
export const ROOT_TYPES: readonly string[];
export function walkCrossParentFields(
  sdl: string,
  nonEntityTypes: string[],
): Array<{ coord: string; parent: string; field: string; target: string }>;
export function checkManifest(args: {
  sdl: string;
  manifest: unknown;
  root?: string;
}): { problems: string[]; inScope: number };
