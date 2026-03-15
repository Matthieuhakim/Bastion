import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { router } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';

export function createApp(): express.Express {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS
  app.use(cors());

  // Body parsing
  app.use(express.json({ limit: '1mb' }));

  // Attach a unique request ID to every request
  app.use(requestId);

  // Routes
  app.use(router);

  // Global error handler (must be registered last)
  app.use(errorHandler);

  return app;
}
