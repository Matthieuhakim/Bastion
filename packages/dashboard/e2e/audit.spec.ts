import { test, expect } from '@playwright/test';
import { ADMIN_KEY, seedTestData, triggerAllowedRequest } from './helpers';

test.describe('Audit Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('API Key').fill(ADMIN_KEY);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/agents/);
  });

  test('shows agent selector prompt when no agent selected', async ({ page }) => {
    await page.getByRole('link', { name: 'Audit Log' }).click();
    await expect(page).toHaveURL(/\/audit/);
    await expect(page.getByText('Select an agent to view audit records')).toBeVisible();
  });

  test('displays audit records after selecting an agent', async ({ page }) => {
    const testData = await seedTestData();

    // Generate an audit record
    await triggerAllowedRequest(testData.agentSecret, testData.credential.id);

    await page.getByRole('link', { name: 'Audit Log' }).click();

    // Select the agent from the first select (agent filter)
    const agentSelect = page.locator('select').first();
    await agentSelect.selectOption({ label: testData.agent.name });

    // Should show the audit record with action and decision badge
    await expect(page.getByText('test.read').first()).toBeVisible({ timeout: 10000 });
    // Check for the ALLOW badge in the table (not the <option> in the filter dropdown)
    const tableBody = page.locator('tbody');
    await expect(tableBody.getByText('ALLOW').first()).toBeVisible();
  });

  test('verify chain button shows integrity result', async ({ page }) => {
    const testData = await seedTestData();

    await triggerAllowedRequest(testData.agentSecret, testData.credential.id);

    await page.getByRole('link', { name: 'Audit Log' }).click();
    const agentSelect = page.locator('select').first();
    await agentSelect.selectOption({ label: testData.agent.name });

    await expect(page.getByText('test.read').first()).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Verify Chain' }).click();

    await expect(page.getByText(/Chain verified|integrity intact/)).toBeVisible({ timeout: 10000 });
  });

  test('filters by policy decision', async ({ page }) => {
    const testData = await seedTestData();

    await triggerAllowedRequest(testData.agentSecret, testData.credential.id);

    await page.getByRole('link', { name: 'Audit Log' }).click();
    const agentSelect = page.locator('select').first();
    await agentSelect.selectOption({ label: testData.agent.name });
    await expect(page.getByText('test.read').first()).toBeVisible({ timeout: 10000 });

    // Filter by DENY
    const decisionSelect = page.locator('select').nth(1);
    await decisionSelect.selectOption('DENY');

    await expect(page.getByText('No audit records found')).toBeVisible({ timeout: 10000 });
  });
});
