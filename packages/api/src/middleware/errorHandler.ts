import type { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.js';

interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal Server Error' : err.message;
  const requestId = typeof res.getHeader === 'function' ? res.getHeader('X-Request-Id') : undefined;

  if (statusCode === 500) {
    logger.error('Unhandled request error', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack,
    });
  } else {
    logger.warn('Request failed', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      errorName: err.name,
      errorMessage: err.message,
    });
  }

  res.status(statusCode).json({
    error: {
      message,
      ...(process.env['NODE_ENV'] === 'development' && { stack: err.stack }),
    },
  });
}
