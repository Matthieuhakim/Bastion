import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeProxy } from './proxy.js';
import type { ProxyExecuteInput } from './proxy.js';
import { ForbiddenError, ValidationError } from '../errors.js';

// Mock dependencies
vi.mock('./db.js', () => ({
  prisma: {
    credential: {
      findUnique: vi.fn(),
    },
    agent: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('./credentials.js', () => ({
  decryptCredential: vi.fn(),
}));

vi.mock('./policyEngine.js', () => ({
  evaluateRequest: vi.fn(),
  commitRateLimitAndSpend: vi.fn(),
}));

vi.mock('./httpClient.js', () => ({
  callExternalApi: vi.fn(),
  DEFAULT_TIMEOUT_MS: 30_000,
  MAX_TIMEOUT_MS: 120_000,
}));

vi.mock('./hitl.js', () => ({
  createPendingRequest: vi.fn(),
  waitForResolution: vi.fn(),
}));

vi.mock('./notifications.js', () => ({
  sendWebhookNotification: vi.fn().mockResolvedValue(undefined),
  buildWebhookPayload: vi.fn().mockReturnValue({}),
}));

import { prisma } from './db.js';
import { decryptCredential } from './credentials.js';
import { evaluateRequest, commitRateLimitAndSpend } from './policyEngine.js';
import { callExternalApi } from './httpClient.js';
import { createPendingRequest, waitForResolution } from './hitl.js';

const mockFindCredential = prisma.credential.findUnique as ReturnType<typeof vi.fn>;
const mockFindAgent = prisma.agent.findUnique as ReturnType<typeof vi.fn>;
const mockDecrypt = decryptCredential as ReturnType<typeof vi.fn>;
const mockEvaluate = evaluateRequest as ReturnType<typeof vi.fn>;
const mockCommit = commitRateLimitAndSpend as ReturnType<typeof vi.fn>;
const mockCallApi = callExternalApi as ReturnType<typeof vi.fn>;
const mockCreatePending = createPendingRequest as ReturnType<typeof vi.fn>;
const mockWaitForResolution = waitForResolution as ReturnType<typeof vi.fn>;

function makeInput(overrides: Partial<ProxyExecuteInput> = {}): ProxyExecuteInput {
  return {
    agentId: 'agent-1',
    credentialId: 'cred-1',
    action: 'test.get',
    params: {},
    target: {
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {},
    },
    ...overrides,
  };
}

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    agentId: 'agent-1',
    type: 'API_KEY',
    name: 'Test Key',
    isRevoked: false,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path mocks
  mockFindCredential.mockResolvedValue(makeCredential());
  mockFindAgent.mockResolvedValue(null);
  mockEvaluate.mockResolvedValue({ decision: 'ALLOW', policyId: 'policy-1', reason: 'Allowed' });
  mockDecrypt.mockResolvedValue('sk_test_abc123');
  mockCallApi.mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { result: 'ok' },
  });
  mockCommit.mockResolvedValue(undefined);
});

describe('executeProxy', () => {
  describe('happy path', () => {
    it('executes full proxy flow and returns upstream response', async () => {
      const result = await executeProxy(makeInput());

      expect(result.outcome).toBe('executed');
      expect(result.upstream.status).toBe(200);
      expect(result.upstream.body).toEqual({ result: 'ok' });
      expect(result.meta.credentialId).toBe('cred-1');
      expect(result.meta.action).toBe('test.get');
      expect(result.meta.policyDecision).toBe('ALLOW');
      expect(result.meta.policyId).toBe('policy-1');
      expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('calls services in correct order', async () => {
      await executeProxy(makeInput());

      expect(mockFindCredential).toHaveBeenCalledBefore(mockEvaluate);
      expect(mockEvaluate).toHaveBeenCalledBefore(mockDecrypt);
      expect(mockDecrypt).toHaveBeenCalledBefore(mockCallApi);
      expect(mockCallApi).toHaveBeenCalledBefore(mockCommit);
    });

    it('commits rate limit and spend after successful upstream call', async () => {
      await executeProxy(makeInput({ params: { amount: 100 } }));

      expect(mockCommit).toHaveBeenCalledWith('agent-1', 'cred-1', { amount: 100 });
    });
  });

  describe('credential ownership', () => {
    it('throws ForbiddenError when credential not found', async () => {
      mockFindCredential.mockResolvedValue(null);

      await expect(executeProxy(makeInput())).rejects.toThrow(ForbiddenError);
      await expect(executeProxy(makeInput())).rejects.toThrow('Credential not found');
    });

    it('throws ForbiddenError when credential belongs to different agent', async () => {
      mockFindCredential.mockResolvedValue(makeCredential({ agentId: 'other-agent' }));

      await expect(executeProxy(makeInput())).rejects.toThrow(ForbiddenError);
      await expect(executeProxy(makeInput())).rejects.toThrow(
        'Credential does not belong to this agent',
      );
    });
  });

  describe('policy evaluation', () => {
    it('throws ForbiddenError on DENY', async () => {
      mockEvaluate.mockResolvedValue({
        decision: 'DENY',
        policyId: 'policy-1',
        reason: 'Action denied',
      });

      await expect(executeProxy(makeInput())).rejects.toThrow(ForbiddenError);
      await expect(executeProxy(makeInput())).rejects.toThrow('Action denied');
      // Upstream should not be called
      expect(mockCallApi).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
    });

    it('passes params to evaluateRequest', async () => {
      await executeProxy(makeInput({ params: { amount: 500, ip: '10.0.0.1' } }));

      expect(mockEvaluate).toHaveBeenCalledWith(
        'agent-1',
        'cred-1',
        'test.get',
        { amount: 500, ip: '10.0.0.1' },
      );
    });
  });

  describe('HITL escalation', () => {
    beforeEach(() => {
      mockEvaluate.mockResolvedValue({
        decision: 'ESCALATE',
        policyId: 'policy-1',
        reason: 'Amount exceeds threshold',
      });
      mockCreatePending.mockResolvedValue({
        requestId: 'hitl-req-1',
        status: 'pending',
        agentId: 'agent-1',
        credentialId: 'cred-1',
        action: 'test.get',
        params: {},
        target: { url: 'https://api.example.com/data', method: 'GET', headers: {} },
        policyId: 'policy-1',
        reason: 'Amount exceeds threshold',
        createdAt: new Date().toISOString(),
      });
    });

    it('executes upstream call when HITL is approved', async () => {
      mockWaitForResolution.mockResolvedValue('approved');

      const result = await executeProxy(makeInput());

      expect(result.outcome).toBe('executed');
      expect(result.upstream.status).toBe(200);
      expect(result.meta.hitlRequestId).toBe('hitl-req-1');
      expect(mockDecrypt).toHaveBeenCalled();
      expect(mockCallApi).toHaveBeenCalled();
      expect(mockCommit).toHaveBeenCalled();
    });

    it('throws ForbiddenError when HITL is denied', async () => {
      mockWaitForResolution.mockResolvedValue('denied');

      await expect(executeProxy(makeInput())).rejects.toThrow(ForbiddenError);
      await expect(executeProxy(makeInput())).rejects.toThrow('denied by human reviewer');
      expect(mockDecrypt).not.toHaveBeenCalled();
      expect(mockCallApi).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError on HITL timeout', async () => {
      mockWaitForResolution.mockResolvedValue('timeout');

      await expect(executeProxy(makeInput())).rejects.toThrow(ForbiddenError);
      await expect(executeProxy(makeInput())).rejects.toThrow('timed out waiting for human approval');
      expect(mockDecrypt).not.toHaveBeenCalled();
      expect(mockCallApi).not.toHaveBeenCalled();
    });

    it('creates a pending request with correct input', async () => {
      mockWaitForResolution.mockResolvedValue('approved');

      await executeProxy(makeInput({ params: { amount: 5000 } }));

      expect(mockCreatePending).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          credentialId: 'cred-1',
          action: 'test.get',
          params: { amount: 5000 },
        }),
        { policyId: 'policy-1', reason: 'Amount exceeds threshold' },
      );
    });

    it('fires webhook when agent has callbackUrl', async () => {
      mockWaitForResolution.mockResolvedValue('approved');
      mockFindAgent.mockResolvedValue({ id: 'agent-1', callbackUrl: 'https://example.com/hook' });

      const { sendWebhookNotification } = await import('./notifications.js');
      await executeProxy(makeInput());

      expect(sendWebhookNotification).toHaveBeenCalled();
    });

    it('does not fire webhook when agent has no callbackUrl', async () => {
      mockWaitForResolution.mockResolvedValue('approved');
      mockFindAgent.mockResolvedValue({ id: 'agent-1', callbackUrl: null });

      const { sendWebhookNotification } = await import('./notifications.js');
      await executeProxy(makeInput());

      expect(sendWebhookNotification).not.toHaveBeenCalled();
    });
  });

  describe('credential injection', () => {
    it('injects API_KEY as Authorization Bearer header by default', async () => {
      mockDecrypt.mockResolvedValue('sk_test_key');
      mockFindCredential.mockResolvedValue(makeCredential({ type: 'API_KEY' }));

      await executeProxy(makeInput());

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].headers['Authorization']).toBe('Bearer sk_test_key');
    });

    it('injects OAUTH2 as Authorization Bearer header by default', async () => {
      mockDecrypt.mockResolvedValue('oauth_token_123');
      mockFindCredential.mockResolvedValue(makeCredential({ type: 'OAUTH2' }));

      await executeProxy(makeInput());

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].headers['Authorization']).toBe('Bearer oauth_token_123');
    });

    it('throws ValidationError for CUSTOM type without injection config', async () => {
      mockFindCredential.mockResolvedValue(makeCredential({ type: 'CUSTOM' }));

      await expect(executeProxy(makeInput())).rejects.toThrow(ValidationError);
      await expect(executeProxy(makeInput())).rejects.toThrow(
        'CUSTOM credential type requires an explicit injection configuration',
      );
    });

    it('uses custom header injection', async () => {
      mockDecrypt.mockResolvedValue('my-api-key');

      await executeProxy(
        makeInput({
          injection: { location: 'header', key: 'X-Api-Key' },
        }),
      );

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].headers['X-Api-Key']).toBe('my-api-key');
    });

    it('uses Bearer prefix for Authorization header in custom injection', async () => {
      mockDecrypt.mockResolvedValue('my-token');

      await executeProxy(
        makeInput({
          injection: { location: 'header', key: 'Authorization' },
        }),
      );

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].headers['Authorization']).toBe('Bearer my-token');
    });

    it('injects credential into query param', async () => {
      mockDecrypt.mockResolvedValue('query-key');

      await executeProxy(
        makeInput({
          injection: { location: 'query', key: 'api_key' },
        }),
      );

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].url).toContain('api_key=query-key');
    });

    it('injects credential into body field', async () => {
      mockDecrypt.mockResolvedValue('body-secret');

      await executeProxy(
        makeInput({
          target: {
            url: 'https://api.example.com/data',
            method: 'POST',
            headers: {},
            body: { existing: 'data' },
          },
          injection: { location: 'body', key: 'secret' },
        }),
      );

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].body).toEqual({ existing: 'data', secret: 'body-secret' });
    });

    it('creates body object when injecting into body with no existing body', async () => {
      mockDecrypt.mockResolvedValue('body-secret');

      await executeProxy(
        makeInput({
          injection: { location: 'body', key: 'token' },
        }),
      );

      const [callArgs] = mockCallApi.mock.calls;
      expect(callArgs[0].body).toEqual({ token: 'body-secret' });
    });
  });

  describe('SSRF protection', () => {
    it('blocks localhost', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'http://localhost:8080/api', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('blocks 127.0.0.1', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'http://127.0.0.1/api', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow('local address');
    });

    it('blocks ::1', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'http://[::1]/api', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('blocks .local domains', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'http://myservice.local/api', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow('local address');
    });

    it('blocks link-local addresses (169.254.x.x)', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'http://169.254.169.254/metadata', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow('link-local');
    });

    it('blocks non-http protocols', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'ftp://files.example.com/data', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow('http or https');
    });

    it('rejects invalid URLs', async () => {
      await expect(
        executeProxy(
          makeInput({
            target: { url: 'not-a-url', method: 'GET', headers: {} },
          }),
        ),
      ).rejects.toThrow('valid URL');
    });
  });

  describe('upstream failure', () => {
    it('does not commit counters when upstream call fails', async () => {
      const { BadGatewayError } = await import('../errors.js');
      mockCallApi.mockRejectedValue(new BadGatewayError('Upstream failed'));

      await expect(executeProxy(makeInput())).rejects.toThrow(BadGatewayError);
      expect(mockCommit).not.toHaveBeenCalled();
    });
  });

  describe('timeout', () => {
    it('passes timeout to callExternalApi', async () => {
      await executeProxy(makeInput({ timeout: 5000 }));

      const [, timeoutArg] = mockCallApi.mock.calls[0];
      expect(timeoutArg).toBe(5000);
    });
  });
});
