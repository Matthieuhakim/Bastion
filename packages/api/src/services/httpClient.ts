import { BadGatewayError } from '../errors.js';

export interface ExternalRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ExternalResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024; // 5MB

export async function callExternalApi(
  request: ExternalRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExternalResponse> {
  const effectiveTimeout = Math.max(1000, Math.min(timeoutMs, MAX_TIMEOUT_MS));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const fetchInit: RequestInit = {
      method: request.method,
      headers: { ...request.headers },
      signal: controller.signal,
    };

    if (request.body !== undefined) {
      const headers = fetchInit.headers as Record<string, string>;
      const hasContentType = Object.keys(request.headers).some(
        (k) => k.toLowerCase() === 'content-type',
      );

      if (typeof request.body === 'string') {
        fetchInit.body = request.body;
      } else {
        fetchInit.body = JSON.stringify(request.body);
        if (!hasContentType) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await fetch(request.url, fetchInit);

    // Convert Headers to plain object
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Read body with size limit
    const contentType = response.headers.get('content-type') ?? '';
    let body: unknown;

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_RESPONSE_BODY_BYTES) {
      const truncated = arrayBuffer.slice(0, MAX_RESPONSE_BODY_BYTES);
      const text = new TextDecoder().decode(truncated);
      body = { _truncated: true, partial: text };
    } else {
      const text = new TextDecoder().decode(arrayBuffer);
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } else {
        body = text;
      }
    }

    return { status: response.status, headers: responseHeaders, body };
  } catch (err: unknown) {
    if (err instanceof BadGatewayError) throw err;

    const error = err as Error;
    if (error.name === 'AbortError') {
      throw new BadGatewayError(`Upstream request timed out after ${effectiveTimeout}ms`);
    }
    throw new BadGatewayError(`Upstream request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}
