import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'npm run dev --workspace=packages/api',
      cwd: '../..',
      port: 3000,
      reuseExistingServer: true,
      timeout: 15000,
    },
    {
      command: 'npm run dev --workspace=packages/dashboard',
      cwd: '../..',
      port: 5173,
      reuseExistingServer: true,
      timeout: 15000,
    },
  ],
});
