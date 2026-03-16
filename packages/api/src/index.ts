import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Bastion API running on port ${config.port} [${config.nodeEnv}]`);
});

// HITL long-poll requests can block up to 15 minutes; extend Node's default 5-min timeout
server.requestTimeout = 16 * 60 * 1000;
