import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { router } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';

export function createApp(): express.Express {
  const app = express();
  const dashboardDistDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../dashboard/dist',
  );
  const dashboardIndexFile = path.join(dashboardDistDir, 'index.html');

  if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }

  // Security headers
  app.use(helmet());

  // CORS
  app.use(cors({ origin: config.corsOrigins }));

  // Body parsing
  app.use(express.json({ limit: '1mb' }));

  // Attach a unique request ID to every request
  app.use(requestId);

  if (config.nodeEnv === 'production') {
    app.use(express.static(dashboardDistDir));

    // Let the API own client-side routes in production so one container serves the SPA and API.
    app.get(/^(?!\/(?:v1|health)(?:\/|$)).*/, (_req, res) => {
      res.sendFile(dashboardIndexFile);
    });
  }

  // Routes
  app.use(router);

  // Global error handler (must be registered last)
  app.use(errorHandler);

  return app;
}
