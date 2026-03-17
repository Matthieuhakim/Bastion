import { describe, it, expect } from 'vitest';
import { adaptToolResult, buildBastionResponse } from '../responseAdapter.js';
import type { ProxyExecuteResult } from '@bastion-ai/sdk';

const baseResult: ProxyExecuteResult = {
  upstream: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { id: 'ch_123', amount: 5000 },
  },
  meta: {
    credentialId: 'cred_stripe',
    action: 'stripe.charges',
    policyDecision: 'ALLOW',
    policyId: 'pol_abc',
    durationMs: 142,
  },
};

describe('buildBastionResponse', () => {
  it('maps status, headers, body, and url', () => {
    const result = buildBastionResponse(baseResult, 'https://api.stripe.com/v1/charges');
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ 'content-type': 'application/json' });
    expect(result.body).toEqual({ id: 'ch_123', amount: 5000 });
    expect(result.url).toBe('https://api.stripe.com/v1/charges');
  });

  it('includes _bastion metadata', () => {
    const result = buildBastionResponse(baseResult, 'https://api.stripe.com/v1/charges');
    expect(result._bastion).toEqual({
      credentialId: 'cred_stripe',
      action: 'stripe.charges',
      policyDecision: 'ALLOW',
      durationMs: 142,
    });
  });

  it('includes hitlRequestId in _bastion when present', () => {
    const withHitl: ProxyExecuteResult = {
      ...baseResult,
      meta: { ...baseResult.meta, hitlRequestId: 'hitl_req_xyz' },
    };
    const result = buildBastionResponse(withHitl, 'https://api.stripe.com/v1/charges');
    expect(result._bastion.hitlRequestId).toBe('hitl_req_xyz');
  });

  it('does not include hitlRequestId in _bastion when absent', () => {
    const result = buildBastionResponse(baseResult, 'https://api.stripe.com/v1/charges');
    expect(result._bastion.hitlRequestId).toBeUndefined();
  });

  it('handles null body', () => {
    const noBody: ProxyExecuteResult = {
      ...baseResult,
      upstream: { ...baseResult.upstream, body: null },
    };
    const result = buildBastionResponse(noBody, 'https://api.example.com');
    expect(result.body).toBeNull();
  });

  it('handles undefined body as null', () => {
    const noBody: ProxyExecuteResult = {
      ...baseResult,
      upstream: { ...baseResult.upstream, body: undefined },
    };
    const result = buildBastionResponse(noBody, 'https://api.example.com');
    expect(result.body).toBeNull();
  });
});

describe('adaptToolResult', () => {
  it('returns JSON content plus structured details', () => {
    const result = adaptToolResult(baseResult, 'https://api.stripe.com/v1/charges');

    expect(result.details).toMatchObject({
      status: 200,
      url: 'https://api.stripe.com/v1/charges',
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('"status": 200');
    expect(result.content[0]?.text).toContain('"credentialId": "cred_stripe"');
  });
});
