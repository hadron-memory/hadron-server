export const SOURCES_PATH = process.env.SOURCES_PATH || './sources';

/**
 * Convert a graph name (config key) to a namespace.
 * Slashes become dots: "micromentor-org/mmdata" → "micromentor-org.mmdata"
 */
export function graphNameToNamespace(name: string): string {
  return name.replace(/\//g, '.');
}
