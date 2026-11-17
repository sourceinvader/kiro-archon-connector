import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig, cucumberReporter } from 'playwright-bdd';

// Created by the kiro-spec-to-e2e workflow the first time it runs; yours to edit after that.
// While the workflow writes step definitions, this file is frozen: any change to it fails
// the test round, so its checks can only be switched off by a person.

const testDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  // An undefined or ambiguous step fails test generation (bddgen exits 1) before any browser starts.
  missingSteps: 'fail-on-gen',
});

export default defineConfig({
  testDir,
  forbidOnly: true,
  retries: 0,
  // One worker: the dev server is shared, and one ticket's scenarios may touch the same data.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'reports/playwright' }],
    // The workflow reads this file to find which Gherkin step failed.
    cucumberReporter('json', { outputFile: 'reports/cucumber.json' }),
    cucumberReporter('html', { outputFile: 'reports/cucumber.html' }),
  ],
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
