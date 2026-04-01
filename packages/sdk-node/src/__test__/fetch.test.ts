import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBastionFetch } from '../fetch.js';

const BASE_URL = 'http://localhost:3000';
const API_KEY = 'test-agent-secret';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createBastionFetch', () => {
  it('forwards vendor-url requests through Bastion and returns a Response', async () => {
    const nativeFetch = mockFetch(200, {
      upstream: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true },
      },
      meta: {
        credentialId: 'cred_1',
        action: 'openai.post.v1.chat.completions',
        policyDecision: 'ALLOW',
        policyId: 'pol_1',
        durationMs: 15,
      },
    });

    const bastionFetch = createBastionFetch({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: nativeFetch,
    });

    const response = await bastionFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('x-bastion-action')).toBe('openai.post.v1.chat.completions');

    const [url, opts] = nativeFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/proxy/fetch`);
    expect(opts.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(opts.body)).toMatchObject({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      body: { model: 'gpt-5.4-mini' },
    });
  });

  it('captures the original fetch implementation for global overrides', async () => {
    const nativeFetch = mockFetch(200, {
      upstream: {
        status: 204,
        headers: {},
        body: null,
      },
      meta: {
        credentialId: 'cred_1',
        action: 'openai.get.v1.models',
        policyDecision: 'ALLOW',
        policyId: null,
        durationMs: 8,
      },
    });

    global.fetch = nativeFetch;
    const bastionFetch = createBastionFetch({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    });
    global.fetch = bastionFetch;

    const response = await bastionFetch('https://api.openai.com/v1/models');

    expect(response.status).toBe(204);
    expect(nativeFetch).toHaveBeenCalledOnce();
  });
});
