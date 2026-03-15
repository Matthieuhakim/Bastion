import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) ?? uuidv4();
  res.setHeader('X-Request-Id', id);
  next();
}
