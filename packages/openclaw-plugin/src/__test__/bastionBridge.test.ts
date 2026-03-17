import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BastionBridge } from '../bastionBridge.js';
import { BastionUnreachableError, BastionBlockedError } from '../errors.js';
import type { CompiledRule } from '../ruleEngine.js';

const SERVER_URL = 'http://localhost:3000';
const AGENT_SECRET = 'bst_test_secret';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: () => Promise.resolve(body),
  });
}

const stripeRule: CompiledRule = {
  tool: 'web_fetch',
  urlPattern: 'https://api.stripe.com/**',
  urlRegex: /^https:\/\/api\.stripe\.com\/.*/,
  credentialId: 'cred_stripe',
  action: 'stripe.charges',
};

const ruleWithInjection: CompiledRule = {
  ...stripeRule,
  injection: { location: 'header', key: 'X-Api-Key' },
};

const ruleWithParams: CompiledRule = {
  ...stripeRule,
  params: { amount: 'body.amount' },
};

let bridge: BastionBridge;

beforeEach(() => {
  bridge = new BastionBridge(SERVER_URL, AGENT_SECRET, 30_000);
  vi.restoreAllMocks();
});

describe('executeProxy', () => {
  it('sends correct ProxyExecuteInput from rule + tool args', async () => {
    const proxyResult = {
      upstream: { status: 200, headers: {}, body: { id: 'ch_123' } },
      meta: {
        credentialId: 'cred_stripe',
        action: 'stripe.charges',
        policyDecision: 'ALLOW',
        policyId: 'pol_1',
        durationMs: 100,
      },
    };
    global.fetch = mockFetch(200, proxyResult);

    const result = await bridge.executeProxy(stripeRule, {
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      headers: { 'X-Custom': 'header' },
      body: { amount: 5000 },
    });

    expect(result).toEqual(proxyResult);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${SERVER_URL}/v1/proxy/execute`);
    expect(opts.method).toBe('POST');

    const sent = JSON.parse(opts.body);
    expect(sent.credentialId).toBe('cred_stripe');
    expect(sent.action).toBe('stripe.charges');
    expect(sent.target.url).toBe('https://api.stripe.com/v1/charges');
    expect(sent.target.method).toBe('POST');
    expect(sent.target.headers).toEqual({ 'X-Custom': 'header' });
    expect(sent.target.body).toEqual({ amount: 5000 });
  });

  it('defaults method to GET if not provided', async () => {
    global.fetch = mockFetch(200, { upstream: {}, meta: {} });
    await bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' });
    const sent = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.target.method).toBe('GET');
  });

  it('defaults headers to empty object if not provided', async () => {
    global.fetch = mockFetch(200, { upstream: {}, meta: {} });
    await bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' });
    const sent = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.target.headers).toEqual({});
  });

  it('includes injection config when rule has one', async () => {
    global.fetch = mockFetch(200, { upstream: {}, meta: {} });
    await bridge.executeProxy(ruleWithInjection, {
      url: 'https://api.stripe.com/v1/charges',
    });
    const sent = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.injection).toEqual({ location: 'header', key: 'X-Api-Key' });
  });

  it('extracts params from tool args when rule has params mapping', async () => {
    global.fetch = mockFetch(200, { upstream: {}, meta: {} });
    await bridge.executeProxy(ruleWithParams, {
      url: 'https://api.stripe.com/v1/charges',
      body: { amount: 9900 },
    });
    const sent = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.params).toEqual({ amount: 9900 });
  });

  it('omits params when rule has no params mapping', async () => {
    global.fetch = mockFetch(200, { upstream: {}, meta: {} });
    await bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' });
    const sent = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.params).toBeUndefined();
  });

  it('throws BastionBlockedError on 403 response', async () => {
    global.fetch = mockFetch(403, { message: 'Policy denied' });
    await expect(
      bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' }),
    ).rejects.toThrow(BastionBlockedError);
    await expect(
      bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' }),
    ).rejects.toThrow('Policy denied');
  });

  it('throws BastionUnreachableError on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' }),
    ).rejects.toThrow(BastionUnreachableError);
  });

  it('re-throws non-network, non-forbidden errors', async () => {
    global.fetch = mockFetch(500, { message: 'Internal error' });
    await expect(
      bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' }),
    ).rejects.not.toBeInstanceOf(BastionBlockedError);
    await expect(
      bridge.executeProxy(stripeRule, { url: 'https://api.stripe.com/v1/charges' }),
    ).rejects.not.toBeInstanceOf(BastionUnreachableError);
  });
});

describe('healthCheck', () => {
  it('returns true when server responds', async () => {
    global.fetch = mockFetch(200, { status: 'ok', timestamp: '', version: '0.1.0' });
    const result = await bridge.healthCheck();
    expect(result).toBe(true);
  });

  it('returns false when server is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await bridge.healthCheck();
    expect(result).toBe(false);
  });
});
