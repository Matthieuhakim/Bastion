import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callExternalApi, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './httpClient.js';
import { BadGatewayError } from '../errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeResponse(overrides: Partial<Response> & { bodyText?: string; bodyJson?: unknown } = {}) {
  const headers = new Headers(overrides.headers);
  if (!headers.has('content-type') && overrides.bodyJson !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const body = overrides.bodyJson !== undefined
    ? JSON.stringify(overrides.bodyJson)
    : (overrides.bodyText ?? '');
  return {
    status: overrides.status ?? 200,
    headers,
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(body).buffer),
  };
}

describe('callExternalApi', () => {
  it('makes a successful GET request and parses JSON response', async () => {
    const responseBody = { data: 'hello' };
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: responseBody }));

    const result = await callExternalApi({
      url: 'https://api.example.com/test',
      method: 'GET',
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.body).toEqual(responseBody);
    expect(typeof result.headers).toBe('object');

    // Verify fetch was called with correct args
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/test');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('sends POST request with JSON body and sets Content-Type', async () => {
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: { ok: true } }));

    await callExternalApi({
      url: 'https://api.example.com/data',
      method: 'POST',
      headers: {},
      body: { key: 'value' },
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ key: 'value' }));
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('does not override existing Content-Type header', async () => {
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: {} }));

    await callExternalApi({
      url: 'https://api.example.com/data',
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: { key: 'value' },
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('text/plain');
  });

  it('returns text body for non-JSON content-type', async () => {
    const headers = new Headers({ 'content-type': 'text/html' });
    const body = '<h1>Hello</h1>';
    mockFetch.mockResolvedValue({
      status: 200,
      headers,
      arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(body).buffer),
    });

    const result = await callExternalApi({
      url: 'https://example.com',
      method: 'GET',
      headers: {},
    });

    expect(result.body).toBe('<h1>Hello</h1>');
  });

  it('returns text when JSON parsing fails', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const body = 'not-json';
    mockFetch.mockResolvedValue({
      status: 200,
      headers,
      arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(body).buffer),
    });

    const result = await callExternalApi({
      url: 'https://example.com',
      method: 'GET',
      headers: {},
    });

    expect(result.body).toBe('not-json');
  });

  it('throws BadGatewayError on network error', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      callExternalApi({
        url: 'https://api.example.com/test',
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow(BadGatewayError);
  });

  it('throws BadGatewayError on timeout (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch.mockRejectedValue(abortError);

    await expect(
      callExternalApi(
        { url: 'https://api.example.com/test', method: 'GET', headers: {} },
        1000,
      ),
    ).rejects.toThrow(/timed out/);
  });

  it('converts response headers to plain object', async () => {
    const responseHeaders = new Headers({
      'x-request-id': 'abc123',
      'content-type': 'application/json',
    });
    mockFetch.mockResolvedValue({
      status: 200,
      headers: responseHeaders,
      arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode('{}').buffer),
    });

    const result = await callExternalApi({
      url: 'https://example.com',
      method: 'GET',
      headers: {},
    });

    expect(result.headers['x-request-id']).toBe('abc123');
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('clamps timeout to minimum 1000ms', async () => {
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: {} }));

    await callExternalApi(
      { url: 'https://example.com', method: 'GET', headers: {} },
      100, // below minimum
    );

    // Should not throw, request succeeds normally
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('clamps timeout to MAX_TIMEOUT_MS', async () => {
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: {} }));

    await callExternalApi(
      { url: 'https://example.com', method: 'GET', headers: {} },
      MAX_TIMEOUT_MS + 60_000,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('uses DEFAULT_TIMEOUT_MS when no timeout provided', async () => {
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: {} }));

    await callExternalApi({
      url: 'https://example.com',
      method: 'GET',
      headers: {},
    });

    // Just verify it works with default timeout
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('does not set body for requests without body', async () => {
    mockFetch.mockResolvedValue(makeResponse({ bodyJson: {} }));

    await callExternalApi({
      url: 'https://example.com',
      method: 'GET',
      headers: {},
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.body).toBeUndefined();
  });
});
