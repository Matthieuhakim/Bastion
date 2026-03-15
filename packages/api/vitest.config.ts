import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/__integration__/**'],
    setupFiles: ['src/__test__/setup.ts'],
  },
});
