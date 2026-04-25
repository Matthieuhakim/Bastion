import { config } from '../config.js';
import type { EvaluationParams, IntentReviewConstraint, PolicyDecision } from './policyEngine.js';
import type { ProxyTarget } from './proxy.js';

export type IntentJudgeDecision = 'SAFE' | 'NEEDS_APPROVAL';
export type IntentRiskLevel = 'low' | 'medium' | 'high';

export interface IntentJudgeVerdict {
  decision: IntentJudgeDecision;
  riskLevel: IntentRiskLevel;
  confidence: number;
  reasons: string[];
  provider: string;
  model: string;
  promptVersion: string;
}

export interface IntentJudgeInput {
  agentId: string;
  credentialId: string;
  credentialName: string;
  credentialType: string;
  credentialMetadata: Record<string, unknown> | null;
  credentialScopes: string[];
  action: string;
  params: EvaluationParams;
  target: ProxyTarget;
  policyDecision: Exclude<PolicyDecision, 'DENY'>;
  policyId: string | null;
  policyReason: string;
  review: IntentReviewConstraint;
}

interface IntentJudgeProvider {
  judge(input: IntentJudgeInput): Promise<Omit<IntentJudgeVerdict, 'provider' | 'model'>>;
}

const PROMPT_VERSION = 'intent-judge-v1';
const MAX_BODY_CHARS = 4_000;
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
]);
const SENSITIVE_METADATA_KEYS = new Set([
  '_displayhint',
  'secret',
  'token',
  'password',
  'apikey',
  'api_key',
  'authorization',
]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value,
    ]),
  );
}

function sanitizeMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      SENSITIVE_METADATA_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value,
    ]),
  );
}

function summarizeBody(body: unknown): unknown {
  if (body === undefined) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body.length > MAX_BODY_CHARS
      ? { _truncated: true, text: body.slice(0, MAX_BODY_CHARS) }
      : body;
  }

  const serialized = JSON.stringify(body);
  if (!serialized || serialized.length <= MAX_BODY_CHARS) {
    return body;
  }

  return {
    _truncated: true,
    json: serialized.slice(0, MAX_BODY_CHARS),
  };
}

function buildJudgePayload(input: IntentJudgeInput): Record<string, unknown> {
  const targetUrl = new URL(input.target.url);

  return {
    agentId: input.agentId,
    credential: {
      id: input.credentialId,
      name: input.credentialName,
      type: input.credentialType,
      metadata: sanitizeMetadata(input.credentialMetadata),
      scopes: input.credentialScopes,
    },
    action: input.action,
    params: input.params,
    target: {
      host: targetUrl.hostname,
      path: targetUrl.pathname,
      method: input.target.method,
      headers: redactHeaders(input.target.headers),
      body: summarizeBody(input.target.body),
    },
    policy: {
      decision: input.policyDecision,
      policyId: input.policyId,
      reason: input.policyReason,
      intentReview: input.review,
    },
  };
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  throw new Error('Intent judge response did not contain JSON');
}

function parseVerdict(value: unknown): Omit<IntentJudgeVerdict, 'provider' | 'model'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Intent judge response must be an object');
  }

  const record = value as Record<string, unknown>;
  const decision = record['decision'];
  const riskLevel = record['riskLevel'];
  const confidence = record['confidence'];
  const reasons = record['reasons'];

  if (decision !== 'SAFE' && decision !== 'NEEDS_APPROVAL') {
    throw new Error('Intent judge decision must be SAFE or NEEDS_APPROVAL');
  }
  if (riskLevel !== 'low' && riskLevel !== 'medium' && riskLevel !== 'high') {
    throw new Error('Intent judge riskLevel must be low, medium, or high');
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('Intent judge confidence must be between 0 and 1');
  }
  if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) {
    throw new Error('Intent judge reasons must be an array of strings');
  }

  return {
    decision,
    riskLevel,
    confidence,
    reasons,
    promptVersion: PROMPT_VERSION,
  };
}

class OpenAIIntentJudgeProvider implements IntentJudgeProvider {
  async judge(input: IntentJudgeInput): Promise<Omit<IntentJudgeVerdict, 'provider' | 'model'>> {
    const response = await fetch(config.intentJudge.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.intentJudge.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.intentJudge.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a security intent judge for outbound API calls. ' +
              'Return JSON only with decision SAFE or NEEDS_APPROVAL, riskLevel low/medium/high, confidence 0..1, and reasons. ' +
              'Require approval for suspicious, destructive, exfiltrating, policy-ambiguous, or harmful intent. ' +
              'Do not approve requests based on convenience.',
          },
          {
            role: 'user',
            content: JSON.stringify(buildJudgePayload(input)),
          },
        ],
      }),
      signal: AbortSignal.timeout(config.intentJudge.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Intent judge provider returned ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Intent judge provider returned no content');
    }

    return parseVerdict(JSON.parse(extractJsonObject(content)));
  }
}

function createProvider(): IntentJudgeProvider {
  switch (config.intentJudge.provider) {
    case 'openai':
      return new OpenAIIntentJudgeProvider();
  }
}

export function isIntentReviewActive(review?: IntentReviewConstraint): boolean {
  return Boolean(review?.enabled && config.intentJudge.enabled);
}

export async function judgeIntent(input: IntentJudgeInput): Promise<IntentJudgeVerdict> {
  try {
    const verdict = await createProvider().judge(input);
    return {
      ...verdict,
      provider: config.intentJudge.provider,
      model: config.intentJudge.model,
    };
  } catch (error) {
    return {
      decision: 'NEEDS_APPROVAL',
      riskLevel: 'high',
      confidence: 1,
      reasons: [
        `Intent judge failed closed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      provider: config.intentJudge.provider,
      model: config.intentJudge.model,
      promptVersion: PROMPT_VERSION,
    };
  }
}
