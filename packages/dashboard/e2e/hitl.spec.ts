import { test, expect } from '@playwright/test';
import { ADMIN_KEY, seedTestData, triggerEscalation } from './helpers';

test.describe('HITL Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);
  });

  test('navigates to HITL queue page', async ({ page }) => {
    await page.getByRole('link', { name: 'HITL Queue' }).click();
    await expect(page).toHaveURL(/\/hitl/);
    await expect(page.getByRole('heading', { name: 'HITL Queue' })).toBeVisible();
    // Page should show either pending requests or empty state
    await expect(
      page
        .getByText('No pending requests')
        .or(page.getByRole('button', { name: 'Approve' }).first()),
    ).toBeVisible({ timeout: 10000 });
  });

  test('shows pending request after escalation trigger', async ({ page }) => {
    const testData = await seedTestData();

    await triggerEscalation(testData.agentSecret, testData.credential.id);
    await page.waitForTimeout(1000);

    await page.getByRole('link', { name: 'HITL Queue' }).click();
    await expect(page).toHaveURL(/\/hitl/);

    await expect(page.getByText('charges.create').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Approve' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' }).first()).toBeVisible();
  });

  test('approve a pending request', async ({ page }) => {
    const testData = await seedTestData();

    await triggerEscalation(testData.agentSecret, testData.credential.id);
    await page.waitForTimeout(1000);

    await page.getByRole('link', { name: 'HITL Queue' }).click();

    // Wait for the specific pending request row
    const row = page.getByRole('row').filter({ hasText: testData.agent.name });
    await expect(row.first()).toBeVisible({ timeout: 10000 });

    await row.first().getByRole('button', { name: 'Approve' }).click();

    // After approval + poll, the row for this agent should disappear
    await expect(row).toHaveCount(0, { timeout: 10000 });
  });

  test('deny a pending request with reason', async ({ page }) => {
    const testData = await seedTestData();

    await triggerEscalation(testData.agentSecret, testData.credential.id);
    await page.waitForTimeout(1000);

    await page.getByRole('link', { name: 'HITL Queue' }).click();

    const row = page.getByRole('row').filter({ hasText: testData.agent.name });
    await expect(row.first()).toBeVisible({ timeout: 10000 });

    // Click Deny to open the dialog
    await row.first().getByRole('button', { name: 'Deny' }).click();

    // Fill in reason and confirm
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Optional reason for denial').fill('Too risky');
    await dialog.getByRole('button', { name: 'Deny' }).click();

    // Row should disappear after denial
    await expect(row).toHaveCount(0, { timeout: 10000 });
  });
});
