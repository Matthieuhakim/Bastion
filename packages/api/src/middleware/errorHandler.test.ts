import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from './errorHandler.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';

function createMocks() {
  const req = {} as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next, status, json };
}

describe('errorHandler', () => {
  it('returns correct statusCode and message for AppError', () => {
    const { req, res, next, status, json } = createMocks();
    const err = new NotFoundError('Agent not found');

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'Agent not found' }) }),
    );
  });

  it('returns 400 for ValidationError', () => {
    const { req, res, next, status, json } = createMocks();
    const err = new ValidationError('name is required');

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'name is required' }) }),
    );
  });

  it('returns 500 and "Internal Server Error" for errors without statusCode', () => {
    const { req, res, next, status, json } = createMocks();
    const err = new Error('something broke');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Internal Server Error' }),
      }),
    );

    vi.restoreAllMocks();
  });

  it('logs to console.error for 500 errors', () => {
    const { req, res, next } = createMocks();
    const err = new Error('unexpected');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(spy).toHaveBeenCalledWith('Unhandled error:', err);

    vi.restoreAllMocks();
  });

  it('does not log to console.error for non-500 errors', () => {
    const { req, res, next } = createMocks();
    const err = new AppError('bad request', 400);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(err, req, res, next);

    expect(spy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('includes stack trace when NODE_ENV is "development"', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';

    const { req, res, next, json } = createMocks();
    const err = new AppError('dev error', 400);

    errorHandler(err, req, res, next);

    const response = json.mock.calls[0][0];
    expect(response.error.stack).toBeDefined();

    process.env['NODE_ENV'] = originalEnv;
  });

  it('excludes stack trace when NODE_ENV is not "development"', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';

    const { req, res, next, json } = createMocks();
    const err = new AppError('prod error', 400);

    errorHandler(err, req, res, next);

    const response = json.mock.calls[0][0];
    expect(response.error.stack).toBeUndefined();

    process.env['NODE_ENV'] = originalEnv;
  });
});
