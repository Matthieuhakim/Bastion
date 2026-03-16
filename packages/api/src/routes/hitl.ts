import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { NotFoundError } from '../errors.js';
import { resolveRequest, getPendingRequest, listPendingRequests } from '../services/hitl.js';

export const hitlRouter = Router();

hitlRouter.use(requireAdmin);

// GET /v1/hitl/pending
hitlRouter.get('/pending', async (_req: Request, res: Response) => {
  const requests = await listPendingRequests();
  res.json(requests);
});

// GET /v1/hitl/:requestId
hitlRouter.get('/:requestId', async (req: Request<{ requestId: string }>, res: Response) => {
  const pending = await getPendingRequest(req.params.requestId);
  if (!pending) {
    throw new NotFoundError('Pending request not found or expired');
  }
  res.json(pending);
});

// POST /v1/hitl/:requestId/approve
hitlRouter.post(
  '/:requestId/approve',
  async (req: Request<{ requestId: string }>, res: Response) => {
    const result = await resolveRequest(req.params.requestId, 'approved');
    res.json({
      requestId: result.requestId,
      status: 'approved',
      message: 'Request approved',
    });
  },
);

// POST /v1/hitl/:requestId/deny
hitlRouter.post('/:requestId/deny', async (req: Request<{ requestId: string }>, res: Response) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const result = await resolveRequest(req.params.requestId, 'denied', reason);
  res.json({
    requestId: result.requestId,
    status: 'denied',
    message: 'Request denied',
  });
});
