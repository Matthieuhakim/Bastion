import { test, expect } from '@playwright/test';
import { ADMIN_KEY, seedTestData } from './helpers';

test.describe('Agents Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);
  });

  test('displays agent list', async ({ page }) => {
    const testData = await seedTestData();

    await page.reload();
    const row = page.getByRole('row').filter({ hasText: testData.agent.name });
    await expect(row).toBeVisible();
    await expect(row.getByText('active')).toBeVisible();
  });

  test('toggle kill switch deactivates agent', async ({ page }) => {
    const testData = await seedTestData();

    await page.reload();
    const row = page.getByRole('row').filter({ hasText: testData.agent.name });
    const toggle = row.getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  test('shows key fingerprint and callback URL', async ({ page }) => {
    const testData = await seedTestData();

    await page.reload();
    const row = page.getByRole('row').filter({ hasText: testData.agent.name });
    await expect(row.locator('.font-mono')).toBeVisible();
    await expect(row.getByText('https://example.com/webhook')).toBeVisible();
  });
});
