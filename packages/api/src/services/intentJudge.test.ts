import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeIntent } from './intentJudge.js';
import type { IntentJudgeInput } from './intentJudge.js';

function makeInput(): IntentJudgeInput {
  return {
    agentId: 'agent-1',
    credentialId: 'cred-1',
    credentialName: 'Stripe key',
    credentialType: 'API_KEY',
    credentialMetadata: {
      provider: 'stripe',
      _displayHint: 'sk_...1234',
    },
    credentialScopes: ['charges:create'],
    action: 'charges.create',
    params: { amount: 100 },
    target: {
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      headers: { Authorization: 'Bearer should-not-leak', 'Idempotency-Key': 'idem-1' },
      body: { amount: 10000, currency: 'usd' },
    },
    policyDecision: 'ALLOW',
    policyId: 'policy-1',
    policyReason: 'Request allowed by policy',
    review: {
      enabled: true,
      mode: 'escalate_on_risk',
      policyId: 'policy-1',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('judgeIntent', () => {
  it('parses a safe provider verdict and redacts sensitive context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'SAFE',
                riskLevel: 'low',
                confidence: 0.95,
                reasons: ['Looks like a normal charge creation.'],
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const verdict = await judgeIntent(makeInput());

    expect(verdict).toMatchObject({
      decision: 'SAFE',
      riskLevel: 'low',
      confidence: 0.95,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const payload = JSON.parse(requestBody.messages[1]!.content) as {
      target: { headers: Record<string, string> };
      credential: { metadata: Record<string, unknown> };
    };

    expect(payload.target.headers['Authorization']).toBe('[REDACTED]');
    expect(payload.credential.metadata['_displayHint']).toBe('[REDACTED]');
  });

  it('fails closed to approval when the provider call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const verdict = await judgeIntent(makeInput());

    expect(verdict.decision).toBe('NEEDS_APPROVAL');
    expect(verdict.riskLevel).toBe('high');
    expect(verdict.reasons[0]).toContain('network down');
  });
});
