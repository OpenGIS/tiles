import { defineConfig, devices } from '@playwright/test';

const HARNESS_URL = 'http://127.0.0.1:11011';
const TILE_SERVER_URL = 'http://127.0.0.1:11010';

export default defineConfig({
  testDir: './test/e2e',
  outputDir: 'tmp/playwright',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: HARNESS_URL,
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'CONFIG_PATH=test/fixtures/harness-layers.json npm run start',
      url: `${TILE_SERVER_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'npm run dev:harness',
      url: HARNESS_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
