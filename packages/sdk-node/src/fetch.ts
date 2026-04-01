import { BastionClient } from './client.js';
import type { BastionClientConfig } from './client.js';

export interface BastionFetchConfig extends BastionClientConfig {
  timeout?: number;
  headers?: HeadersInit;
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  const normalized = new Headers(headers ?? {});
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function normalizeBodyFromText(text: string, contentType: string | null): unknown {
  if (text.length === 0) {
    return undefined;
  }

  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

async function normalizeRequestBody(request: Request): Promise<unknown> {
  const text = await request.text();
  return normalizeBodyFromText(text, request.headers.get('content-type'));
}

function normalizeBodyInit(body: BodyInit | null | undefined, contentType: string | null): unknown {
  if (body == null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return normalizeBodyFromText(body, contentType);
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ReadableStream
  ) {
    throw new Error(
      'createBastionFetch currently supports string and URLSearchParams request bodies only.',
    );
  }

  return body;
}

function buildResponseBody(body: unknown): BodyInit | null {
  if (body == null) {
    return null;
  }

  if (typeof body === 'string') {
    return body;
  }

  return JSON.stringify(body);
}

export function createBastionFetch(config: BastionFetchConfig): typeof fetch {
  const transport = config.fetch ?? globalThis.fetch.bind(globalThis);
  const client = new BastionClient({
    ...config,
    fetch: transport,
  });
  const defaultHeaders = headersToObject(config.headers);

  return async function bastionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let request: Request;

    if (input instanceof Request) {
      request = init ? new Request(input, init) : input.clone();
    } else {
      request = new Request(input, init);
    }

    const headers = {
      ...defaultHeaders,
      ...headersToObject(request.headers),
    };
    const body = await normalizeRequestBody(request);
    const result = await client.proxyRequest({
      url: request.url,
      method: request.method,
      headers,
      body,
      timeout: config.timeout,
    });

    const responseHeaders = new Headers(result.upstream.headers);
    responseHeaders.set('x-bastion-action', result.meta.action);
    responseHeaders.set('x-bastion-credential-id', result.meta.credentialId);
    responseHeaders.set('x-bastion-policy-decision', result.meta.policyDecision);
    if (result.meta.policyId) {
      responseHeaders.set('x-bastion-policy-id', result.meta.policyId);
    }

    const responseBody = buildResponseBody(result.upstream.body);
    if (responseBody && typeof result.upstream.body !== 'string' && !responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', 'application/json');
    }

    return new Response(responseBody, {
      status: result.upstream.status,
      headers: responseHeaders,
    });
  };
}

export function installBastionFetchGlobal(config: BastionFetchConfig): typeof fetch {
  const bastionFetch = createBastionFetch(config);
  globalThis.fetch = bastionFetch;
  return bastionFetch;
}

export function normalizeBastionBody(
  body: BodyInit | null | undefined,
  contentType: string | null,
): unknown {
  return normalizeBodyInit(body, contentType);
}
