import type { Request, Response, NextFunction } from 'express';
import { requestId } from './requestId.js';

function createMocks(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = { setHeader: vi.fn() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('requestId middleware', () => {
  it('sets X-Request-Id header on response', () => {
    const { req, res, next } = createMocks();
    requestId(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', expect.any(String));
  });

  it('uses existing X-Request-Id from request headers', () => {
    const { req, res, next } = createMocks({ 'x-request-id': 'existing-id-123' });
    requestId(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'existing-id-123');
  });

  it('generates a UUID when no X-Request-Id header present', () => {
    const { req, res, next } = createMocks();
    requestId(req, res, next);
    const id = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('calls next()', () => {
    const { req, res, next } = createMocks();
    requestId(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
