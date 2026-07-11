import { defineConfig, devices } from "@playwright/test";

const localPort = process.env.PLAYWRIGHT_PORT ?? "4174";
const localBaseURL = `http://127.0.0.1:${localPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.VOICE_BASE_URL ?? localBaseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.VOICE_BASE_URL
    ? undefined
    : {
        command: `npm run dev -- --host 127.0.0.1 --port ${localPort}`,
        url: localBaseURL,
        reuseExistingServer: !process.env.CI,
      },
});
