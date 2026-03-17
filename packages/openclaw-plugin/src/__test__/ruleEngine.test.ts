import { describe, it, expect } from 'vitest';
import { compileRules, matchRule, matchRuleByUrl, extractParams } from '../ruleEngine.js';
import type { InterceptionRule } from '../types.js';

const stripeRule: InterceptionRule = {
  tool: 'web_fetch',
  urlPattern: 'https://api.stripe.com/**',
  credentialId: 'cred_stripe',
  action: 'stripe.charges',
};

const githubRule: InterceptionRule = {
  tool: 'web_fetch',
  urlPattern: 'https://api.github.com/repos/*/issues',
  credentialId: 'cred_github',
  action: 'github.issues',
};

const exactRule: InterceptionRule = {
  tool: 'web_fetch',
  urlPattern: 'https://api.example.com/health',
  credentialId: 'cred_example',
  action: 'example.health',
};

const toollessRule: InterceptionRule = {
  urlPattern: 'https://api.example.com/**',
  credentialId: 'cred_toolless',
  action: 'example.api',
};

describe('compileRules', () => {
  it('compiles rules with urlRegex', () => {
    const compiled = compileRules([stripeRule]);
    expect(compiled[0].urlRegex).toBeInstanceOf(RegExp);
    expect(compiled[0].credentialId).toBe('cred_stripe');
  });
});

describe('matchRule — explicit tool blocking', () => {
  const rules = compileRules([stripeRule]);

  it('matches URL under the wildcard path', () => {
    const match = matchRule('web_fetch', { url: 'https://api.stripe.com/v1/charges' }, rules);
    expect(match?.credentialId).toBe('cred_stripe');
  });

  it('matches URL with multiple path segments', () => {
    const match = matchRule(
      'web_fetch',
      { url: 'https://api.stripe.com/v1/customers/cus_123/sources' },
      rules,
    );
    expect(match?.credentialId).toBe('cred_stripe');
  });

  it('matches base URL without trailing path', () => {
    const match = matchRule('web_fetch', { url: 'https://api.stripe.com/' }, rules);
    expect(match?.credentialId).toBe('cred_stripe');
  });

  it('does not match a different domain', () => {
    const match = matchRule('web_fetch', { url: 'https://api.github.com/v1/charges' }, rules);
    expect(match).toBeNull();
  });

  it('returns null for non-matching tool name', () => {
    const match = matchRule('gmail_send', { url: 'https://api.stripe.com/v1/charges' }, rules);
    expect(match).toBeNull();
  });

  it('returns null if url is not in args', () => {
    const match = matchRule('web_fetch', { method: 'GET' }, rules);
    expect(match).toBeNull();
  });

  it('returns null if url is not a string', () => {
    const match = matchRule('web_fetch', { url: 42 }, rules);
    expect(match).toBeNull();
  });

  it('ignores rules without an explicit tool', () => {
    const rulesWithToolless = compileRules([toollessRule]);
    const match = matchRule('web_fetch', { url: 'https://api.example.com/v1/data' }, rulesWithToolless);
    expect(match).toBeNull();
  });
});

describe('matchRule — glob * (single segment)', () => {
  const rules = compileRules([githubRule]);

  it('matches single-segment wildcard', () => {
    const match = matchRule(
      'web_fetch',
      { url: 'https://api.github.com/repos/myorg/issues' },
      rules,
    );
    expect(match?.credentialId).toBe('cred_github');
  });

  it('does not match multi-segment where single * is used', () => {
    const match = matchRule(
      'web_fetch',
      { url: 'https://api.github.com/repos/org/repo/sub/issues' },
      rules,
    );
    expect(match).toBeNull();
  });
});

describe('matchRule — exact URL', () => {
  const rules = compileRules([exactRule]);

  it('matches exact URL', () => {
    const match = matchRule('web_fetch', { url: 'https://api.example.com/health' }, rules);
    expect(match?.credentialId).toBe('cred_example');
  });

  it('does not match URL with extra path', () => {
    const match = matchRule('web_fetch', { url: 'https://api.example.com/health/status' }, rules);
    expect(match).toBeNull();
  });
});

describe('matchRuleByUrl — registered bastion_fetch tool', () => {
  it('matches by URL even when a rule is configured to block another tool', () => {
    const rules = compileRules([stripeRule]);
    const match = matchRuleByUrl({ url: 'https://api.stripe.com/v1/charges' }, rules);
    expect(match?.credentialId).toBe('cred_stripe');
  });

  it('matches rules without a tool field', () => {
    const rules = compileRules([toollessRule]);
    const match = matchRuleByUrl({ url: 'https://api.example.com/v1/data' }, rules);
    expect(match?.credentialId).toBe('cred_toolless');
  });

  it('returns null when the URL does not match any rule', () => {
    const rules = compileRules([stripeRule]);
    const match = matchRuleByUrl({ url: 'https://api.github.com/repos' }, rules);
    expect(match).toBeNull();
  });

  it('returns the first matching rule', () => {
    const rule1: InterceptionRule = {
      urlPattern: 'https://api.stripe.com/**',
      credentialId: 'cred_first',
      action: 'first',
    };
    const rule2: InterceptionRule = {
      urlPattern: 'https://api.stripe.com/v1/**',
      credentialId: 'cred_second',
      action: 'second',
    };
    const rules = compileRules([rule1, rule2]);
    const match = matchRuleByUrl({ url: 'https://api.stripe.com/v1/charges' }, rules);
    expect(match?.credentialId).toBe('cred_first');
  });
});

describe('extractParams', () => {
  it('extracts top-level amount', () => {
    const result = extractParams({ amount: 5000 }, { amount: 'amount' });
    expect(result.amount).toBe(5000);
  });

  it('extracts nested amount via dot-path', () => {
    const result = extractParams({ body: { amount: 9900 } }, { amount: 'body.amount' });
    expect(result.amount).toBe(9900);
  });

  it('parses string amount to number', () => {
    const result = extractParams({ amount: '1234.56' }, { amount: 'amount' });
    expect(result.amount).toBe(1234.56);
  });

  it('ignores non-numeric amount', () => {
    const result = extractParams({ amount: 'not-a-number' }, { amount: 'amount' });
    expect(result.amount).toBeUndefined();
  });

  it('extracts ip from dot-path', () => {
    const result = extractParams({ meta: { ip: '1.2.3.4' } }, { ip: 'meta.ip' });
    expect(result.ip).toBe('1.2.3.4');
  });

  it('returns empty object for empty mapping', () => {
    const result = extractParams({ amount: 100 }, {});
    expect(result).toEqual({});
  });

  it('returns empty object if path not found', () => {
    const result = extractParams({}, { amount: 'body.amount' });
    expect(result).toEqual({});
  });
});
