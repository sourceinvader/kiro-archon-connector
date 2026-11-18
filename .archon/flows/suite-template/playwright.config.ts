import { defineConfig, devices } from '@playwright/test';

// Created by the kiro-flows workflow's setup node the first time it runs; yours to edit
// after that. While the workflow writes tests, this file is frozen: if it changes, the
// round fails. That way retries, timeouts or reporters can only be changed by a person.

export default defineConfig({
  testDir: 'tests',
  forbidOnly: true,
  // No retries: a retry hides a flaky test, and the workflow wants to see flakiness.
  retries: 0,
  // One worker: the app is a shared server, and tests that create data shouldn't race.
  workers: 1,
  // Long end-to-end flows are allowed, so give a test up to two minutes.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['line'],
    // The workflow's run node points these at reports/<group>/ so each group keeps its own.
    ['html', { open: 'never', outputFolder: process.env.FLOWS_HTML_DIR ?? 'reports/html' }],
    ['json', { outputFile: process.env.FLOWS_JSON_FILE ?? 'reports/results.json' }],
  ],
  use: {
    // BASE_URL ends with "/"; tests navigate with relative paths such as page.goto('./').
    baseURL: process.env.BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
