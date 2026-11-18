import type { Page } from '@playwright/test';

// TEMPLATE-LOGIN: delete this line once you have written the real login below.
//
// Write this helper yourself before the first run against an app with a login. Every test
// and the smoke check call it, and the workflow never lets the agent change it. While the
// line above is still here, the smoke node refuses to run a group that lists roles.
//
// login(page, role) leaves the page logged in as that role. With no role (the app has no
// login, or features.yaml lists no roles) it just opens the app.
//
// Credentials come from environment variables on the machine that runs the tests, never
// from a file in the repository:
//   E2E_USER_<ROLE> and E2E_PASS_<ROLE>, e.g. E2E_USER_APPROVER and E2E_PASS_APPROVER.
// Export them in the shell before `archon workflow run`.

export async function login(page: Page, role?: string): Promise<void> {
  if (!role) {
    await page.goto('./');
    return;
  }
  const key = role.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const user = process.env[`E2E_USER_${key}`];
  const pass = process.env[`E2E_PASS_${key}`];
  if (!user || !pass) throw new Error(`Set E2E_USER_${key} and E2E_PASS_${key} to log in as "${role}"`);

  // ADJUST: your app's login page, field labels and button. Relative paths stay under
  // BASE_URL ('login', not '/login').
  await page.goto('login');
  await page.getByLabel('Email').fill(user);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait until the app has left the login page, so the next step starts logged in.
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}
