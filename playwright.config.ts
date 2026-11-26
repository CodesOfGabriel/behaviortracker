import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  // Keep native WebKit/video workloads isolated on CPU-only Intel machines.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1180, height: 760 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 7_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  // Exercise the shipped frontend assets. Never reuse an unrelated dev server.
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
