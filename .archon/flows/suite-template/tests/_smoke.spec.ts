import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login } from '../helpers/login';

// Created by the kiro-flows workflow's setup node; frozen while the workflow writes tests.
//
// The smoke node runs this before any model is used. For each role the group lists (or once
// with no role) it logs in, opens the group's entry page and saves the logged-in browser
// state. The workflow hands the first role's saved state to the agent's browser, so
// the agent starts out logged in and never sees a password.
//
// Environment (set by the smoke node):
//   FLOWS_ROLES     comma-separated role ids, may be empty
//   FLOWS_ENTRY     the group's entry path from features.yaml, e.g. /claims
//   FLOWS_AUTH_DIR  where to save <role>.json (or default.json)

const roles = (process.env.FLOWS_ROLES ?? '').split(',').map((r) => r.trim()).filter(Boolean);
// Relative to BASE_URL, so an app served under a path (https://host/app/) keeps it.
const entry = (process.env.FLOWS_ENTRY ?? '/').replace(/^\/+/, '') || './';
const authDir = process.env.FLOWS_AUTH_DIR ?? '.auth';

for (const role of roles.length ? roles : ['default']) {
  test(`smoke: log in as ${role} and open ${entry}`, async ({ page }) => {
    await login(page, role === 'default' ? undefined : role);
    const response = await page.goto(entry);
    expect(response?.status() ?? 200, `opening ${entry}`).toBeLessThan(400);
    fs.mkdirSync(authDir, { recursive: true });
    await page.context().storageState({ path: path.join(authDir, `${role}.json`) });
  });
}
