import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { graphNameToNamespace, loadConfig } from './config.js';

describe('graphNameToNamespace', () => {
  it('converts slash to dot', () => {
    expect(graphNameToNamespace('foo/bar')).toBe('foo.bar');
  });
  it('converts multiple slashes', () => {
    expect(graphNameToNamespace('a/b/c')).toBe('a.b.c');
  });
  it('passthrough for names without slash', () => {
    expect(graphNameToNamespace('simple')).toBe('simple');
  });
  it('handles empty string', () => {
    expect(graphNameToNamespace('')).toBe('');
  });
});

describe('loadConfig', () => {
  let tmpDir: string;
  const originalConfigPath = process.env.CONFIG_PATH;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    process.env.CONFIG_PATH = originalConfigPath;
  });

  it('parses a valid .hadron-controller.yaml', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hadron-config-test-'));
    const yaml = `
graphs:
  test-org/test-repo:
    source: "git@github.com:test-org/test-repo.git"
    version: "latest"
    path: "test-org/test-repo"
    updatedAt: "2026-01-01T00:00:00.000Z"
`;
    writeFileSync(join(tmpDir, '.hadron-controller.yaml'), yaml, 'utf-8');
    process.env.CONFIG_PATH = tmpDir;

    const config = loadConfig();
    expect(config.graphs).toHaveProperty('test-org/test-repo');
    expect(config.graphs['test-org/test-repo'].source).toBe('git@github.com:test-org/test-repo.git');
    expect(config.graphs['test-org/test-repo'].path).toBe('test-org/test-repo');
  });

  it('throws when the config file is missing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hadron-config-test-'));
    process.env.CONFIG_PATH = tmpDir; // dir exists, file does not

    expect(() => loadConfig()).toThrow();
  });

  it('returns empty graphs for a config with no graphs key', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hadron-config-test-'));
    writeFileSync(join(tmpDir, '.hadron-controller.yaml'), 'graphs: {}', 'utf-8');
    process.env.CONFIG_PATH = tmpDir;

    const config = loadConfig();
    expect(config.graphs).toEqual({});
  });
});
