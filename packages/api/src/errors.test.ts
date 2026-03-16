import {
  AppError,
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
} from './errors.js';

describe('AppError', () => {
  it('creates error with message and statusCode', () => {
    const err = new AppError('test error', 418);
    expect(err.message).toBe('test error');
    expect(err.statusCode).toBe(418);
    expect(err.name).toBe('AppError');
  });

  it('is an instance of Error', () => {
    const err = new AppError('test', 400);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ValidationError', () => {
  it('defaults to status 400 and message "Validation failed"', () => {
    const err = new ValidationError();
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Validation failed');
    expect(err.name).toBe('ValidationError');
  });

  it('accepts custom message', () => {
    const err = new ValidationError('bad input');
    expect(err.message).toBe('bad input');
    expect(err.statusCode).toBe(400);
  });

  it('is an instance of AppError and Error', () => {
    const err = new ValidationError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('UnauthorizedError', () => {
  it('defaults to status 401 and message "Unauthorized"', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Unauthorized');
    expect(err.name).toBe('UnauthorizedError');
  });

  it('accepts custom message', () => {
    const err = new UnauthorizedError('bad token');
    expect(err.message).toBe('bad token');
  });
});

describe('NotFoundError', () => {
  it('defaults to status 404 and message "Not found"', () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('NotFoundError');
  });
});

describe('ConflictError', () => {
  it('defaults to status 409 and message "Conflict"', () => {
    const err = new ConflictError();
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Conflict');
    expect(err.name).toBe('ConflictError');
  });
});
