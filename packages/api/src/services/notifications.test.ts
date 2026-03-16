import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildWebhookPayload, sendWebhookNotification } from './notifications.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildWebhookPayload', () => {
  it('constructs payload with approve and deny URLs', () => {
    const payload = buildWebhookPayload('req-1', 'agent-1', 'charges.create', { amount: 5000 }, 'Exceeds threshold');

    expect(payload).toEqual({
      requestId: 'req-1',
      agentId: 'agent-1',
      action: 'charges.create',
      params: { amount: 5000 },
      reason: 'Exceeds threshold',
      approveUrl: expect.stringContaining('/v1/hitl/req-1/approve'),
      denyUrl: expect.stringContaining('/v1/hitl/req-1/deny'),
    });
  });
});

describe('sendWebhookNotification', () => {
  const payload = buildWebhookPayload('req-1', 'agent-1', 'charges.create', {}, 'test reason');

  it('sends POST request to callbackUrl', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));

    await sendWebhookNotification('https://example.com/webhook', payload);

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: expect.any(AbortSignal),
    });
  });

  it('does not throw on network error', async () => {
    mockFetch.mockRejectedValue(new Error('network failure'));

    await expect(
      sendWebhookNotification('https://example.com/webhook', payload),
    ).resolves.toBeUndefined();
  });

  it('does not throw on abort', async () => {
    mockFetch.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('aborted')), 100)),
    );

    await expect(
      sendWebhookNotification('https://example.com/webhook', payload),
    ).resolves.toBeUndefined();
  });
});
