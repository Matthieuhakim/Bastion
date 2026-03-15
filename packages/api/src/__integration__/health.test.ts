import request from 'supertest';
import { createApp } from '../app.js';

const app = createApp();

describe('GET /health', () => {
  it('returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('returns JSON with status "ok"', async () => {
    const res = await request(app).get('/health');
    expect(res.body.status).toBe('ok');
  });

  it('returns timestamp in ISO format', async () => {
    const res = await request(app).get('/health');
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  it('returns version string', async () => {
    const res = await request(app).get('/health');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version).toBe('0.1.0');
  });

  it('sets X-Request-Id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});
