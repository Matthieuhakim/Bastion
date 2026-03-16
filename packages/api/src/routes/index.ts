import { Router } from 'express';
import { healthRouter } from './health.js';
import { agentRouter } from './agents.js';
import { credentialRouter } from './credentials.js';
import { policyRouter } from './policies.js';
import { proxyRouter } from './proxy.js';

export const router = Router();

router.use('/health', healthRouter);
router.use('/v1/agents', agentRouter);
router.use('/v1/credentials', credentialRouter);
router.use('/v1/policies', policyRouter);
router.use('/v1/proxy', proxyRouter);
