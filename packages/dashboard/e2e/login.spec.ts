import { test, expect } from '@playwright/test';
import { ADMIN_KEY } from './helpers';

test.describe('Login', () => {
  test('shows login page when not authenticated', async ({ page }) => {
    await page.goto('/');
    // Should redirect to /login
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Bastion' })).toBeVisible();
    await expect(page.getByLabel('API Key')).toBeVisible();
  });

  test('shows error for invalid API key', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill('invalid-key');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText(/Invalid API key|Authentication failed/)).toBeVisible();
  });

  test('logs in with valid API key and redirects to agents', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  });

  test('persists session across page reloads', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);

    await page.reload();
    await expect(page).toHaveURL(/\/agents/);
  });

  test('logout returns to login page', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);

    // Logout
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
