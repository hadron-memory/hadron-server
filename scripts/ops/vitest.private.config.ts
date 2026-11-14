/** #4118: these tests provision their own clusters, without the application DB/graph harness. */
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['scripts/ops/*.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
