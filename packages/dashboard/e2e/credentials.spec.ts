import { test, expect } from '@playwright/test';
import { ADMIN_KEY, seedTestData } from './helpers';

test.describe('Credentials Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);
  });

  test('displays credential list', async ({ page }) => {
    const testData = await seedTestData();

    await page.getByRole('link', { name: 'Credentials' }).click();
    await expect(page).toHaveURL(/\/credentials/);

    const row = page.getByRole('row').filter({ hasText: testData.credential.name }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.getByText('API_KEY')).toBeVisible();
    await expect(row.getByText('active')).toBeVisible();
  });

  test('filters credentials by agent', async ({ page }) => {
    const testData = await seedTestData();

    await page.getByRole('link', { name: 'Credentials' }).click();

    await page.locator('select').selectOption({ label: testData.agent.name });

    const row = page.getByRole('row').filter({ hasText: testData.credential.name });
    await expect(row).toBeVisible({ timeout: 10000 });
  });

  test('revoke credential with confirmation', async ({ page }) => {
    const testData = await seedTestData();

    await page.getByRole('link', { name: 'Credentials' }).click();

    const row = page.getByRole('row').filter({ hasText: testData.credential.name });
    await expect(row).toBeVisible({ timeout: 10000 });

    await row.getByRole('button', { name: 'Revoke' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Are you sure you want to revoke')).toBeVisible();

    await dialog.getByRole('button', { name: 'Revoke' }).click();

    // After revocation, the row should show revoked status
    await expect(row.getByText('revoked')).toBeVisible({ timeout: 10000 });
  });
});
