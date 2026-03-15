import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__integration__/**/*.test.ts'],
    setupFiles: ['src/__test__/setup.integration.ts'],
    globalSetup: ['src/__test__/globalSetup.integration.ts'],
    testTimeout: 15000,
    fileParallelism: false,
  },
});
