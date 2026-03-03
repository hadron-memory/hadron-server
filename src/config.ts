import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

export interface GraphConfig {
  source: string;
  version: string;
  path: string;
  updatedAt: string;
}

export interface ControllerConfig {
  graphs: Record<string, GraphConfig>;
}

const CONFIG_DIR = process.env.CONFIG_PATH || '.';
const CONFIG_FILE = '.hadron-controller.yaml';

export const SOURCES_PATH = process.env.SOURCES_PATH || './sources';

export function loadConfig(): ControllerConfig {
  const filePath = join(CONFIG_DIR, CONFIG_FILE);
  const raw = readFileSync(filePath, 'utf-8');
  return parse(raw) as ControllerConfig;
}

/**
 * Convert a graph name (config key) to a namespace.
 * Slashes become dots: "micromentor-org/mmdata" → "micromentor-org.mmdata"
 */
export function graphNameToNamespace(name: string): string {
  return name.replace(/\//g, '.');
}
