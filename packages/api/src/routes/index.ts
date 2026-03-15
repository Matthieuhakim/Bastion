import { Router } from 'express';
import { healthRouter } from './health.js';
import { agentRouter } from './agents.js';

export const router = Router();

router.use('/health', healthRouter);
router.use('/v1/agents', agentRouter);
