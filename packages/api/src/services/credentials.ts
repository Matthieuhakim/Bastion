import type { Credential } from '@prisma/client';
import { prisma } from './db.js';
import { encrypt, decrypt } from './encryption.js';
import { NotFoundError } from '../errors.js';

export interface CreateCredentialInput {
  name: string;
  type: 'API_KEY' | 'OAUTH2' | 'CUSTOM';
  value: string;
  agentId: string;
  metadata?: Record<string, unknown>;
  scopes?: string[];
  expiresAt?: Date;
}

export interface CredentialRoutingInjection {
  location: 'header' | 'query' | 'body';
  key: string;
}

export interface CredentialRoutingMetadata {
  provider?: string;
  actionPrefix?: string;
  targetHosts?: string[];
  targetPathPrefixes?: string[];
  injection?: CredentialRoutingInjection;
}

export interface ResolvedCredentialRoute {
  credential: Credential;
  provider: string;
  actionPrefix: string;
  injection?: CredentialRoutingInjection;
  matchedHost: string;
  matchedPathPrefix?: string;
}

function toPrismaBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function generateDisplayHint(value: string): string {
  if (value.length >= 8) {
    return value.slice(0, 3) + '...' + value.slice(-4);
  }
  return '***';
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
}

function inferProviderFromHostname(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length >= 2) {
    const primary = parts[parts.length - 2];
    if (primary.length > 0 && primary !== 'api') {
      return primary;
    }
  }

  return slugify(hostname.replace(/\./g, '-')) || 'http';
}

function parseInjection(value: unknown): CredentialRoutingInjection | undefined {
  const record = asObject(value);
  if (!record) {
    return undefined;
  }

  const location = record['location'];
  const key = record['key'];
  if (
    (location === 'header' || location === 'query' || location === 'body') &&
    typeof key === 'string' &&
    key.trim().length > 0
  ) {
    return { location, key: key.trim() };
  }

  return undefined;
}

function getHostMatchScore(hostname: string, pattern: string): number {
  const normalized = pattern.toLowerCase();

  if (hostname === normalized) {
    return 2_000 + normalized.length;
  }

  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1);
    if (hostname.endsWith(suffix) && hostname !== normalized.slice(2)) {
      return 1_000 + suffix.length;
    }
  }

  return -1;
}

function getBestPathMatch(pathname: string, prefixes: string[]): string | undefined {
  if (prefixes.length === 0) {
    return undefined;
  }

  let bestMatch: string | undefined;
  for (const prefix of prefixes) {
    if (pathname.startsWith(prefix) && (!bestMatch || prefix.length > bestMatch.length)) {
      bestMatch = prefix;
    }
  }

  return bestMatch;
}

function getPathMatchScore(pathname: string, prefixes: string[]): number {
  const bestMatch = getBestPathMatch(pathname, prefixes);
  if (bestMatch) {
    return bestMatch.length;
  }

  return prefixes.length === 0 ? 1 : -1;
}

export function getCredentialRoutingMetadata(
  credential: Pick<Credential, 'metadata'>,
): CredentialRoutingMetadata {
  const metadata = asObject(credential.metadata);
  if (!metadata) {
    return {};
  }

  const provider =
    typeof metadata['provider'] === 'string' && metadata['provider'].trim().length > 0
      ? metadata['provider'].trim()
      : undefined;
  const actionPrefix =
    typeof metadata['actionPrefix'] === 'string' && metadata['actionPrefix'].trim().length > 0
      ? slugify(metadata['actionPrefix'].trim())
      : provider
        ? slugify(provider)
        : undefined;

  return {
    provider,
    actionPrefix,
    targetHosts: normalizeStringArray(metadata['targetHosts']),
    targetPathPrefixes: normalizeStringArray(metadata['targetPathPrefixes']),
    injection: parseInjection(metadata['injection']),
  };
}

export async function createCredential(input: CreateCredentialInput): Promise<Credential> {
  // Validate agent exists
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId } });
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  const encrypted = encrypt(input.value);
  const displayHint = generateDisplayHint(input.value);

  const metadata = {
    ...(input.metadata ?? {}),
    _displayHint: displayHint,
  };

  return prisma.credential.create({
    data: {
      name: input.name,
      type: input.type,
      encryptedBlob: toPrismaBytes(encrypted.encryptedBlob),
      encryptedDek: toPrismaBytes(encrypted.encryptedDek),
      iv: toPrismaBytes(encrypted.iv),
      authTag: toPrismaBytes(encrypted.authTag),
      metadata,
      scopes: input.scopes ?? [],
      expiresAt: input.expiresAt,
      agentId: input.agentId,
    },
  });
}

export async function listCredentials(agentId?: string): Promise<Credential[]> {
  return prisma.credential.findMany({
    where: agentId ? { agentId } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getCredential(id: string): Promise<Credential> {
  const credential = await prisma.credential.findUnique({ where: { id } });
  if (!credential) {
    throw new NotFoundError('Credential not found');
  }
  return credential;
}

export async function revokeCredential(id: string): Promise<Credential> {
  await getCredential(id);
  return prisma.credential.update({
    where: { id },
    data: { isRevoked: true },
  });
}

export async function decryptCredential(id: string): Promise<string> {
  const credential = await getCredential(id);

  if (credential.isRevoked) {
    throw new NotFoundError('Credential is revoked');
  }

  if (credential.expiresAt && credential.expiresAt < new Date()) {
    throw new NotFoundError('Credential has expired');
  }

  return decrypt({
    encryptedBlob: Buffer.from(credential.encryptedBlob),
    encryptedDek: Buffer.from(credential.encryptedDek),
    iv: Buffer.from(credential.iv),
    authTag: Buffer.from(credential.authTag),
  });
}

export async function resolveCredentialForTarget(
  agentId: string,
  targetUrl: string,
): Promise<ResolvedCredentialRoute> {
  const parsed = new URL(targetUrl);
  const credentials = await prisma.credential.findMany({
    where: {
      agentId,
      isRevoked: false,
    },
    orderBy: { createdAt: 'desc' },
  });

  let bestMatch: (ResolvedCredentialRoute & { score: number }) | null = null;
  const now = new Date();

  for (const credential of credentials) {
    if (credential.expiresAt && credential.expiresAt <= now) {
      continue;
    }

    const routing = getCredentialRoutingMetadata(credential);
    const hosts = routing.targetHosts ?? [];
    if (hosts.length === 0) {
      continue;
    }

    let matchedHost: string | undefined;
    let hostScore = -1;
    for (const hostPattern of hosts) {
      const score = getHostMatchScore(parsed.hostname, hostPattern);
      if (score > hostScore) {
        hostScore = score;
        matchedHost = hostPattern;
      }
    }

    if (hostScore < 0 || !matchedHost) {
      continue;
    }

    const pathPrefixes = routing.targetPathPrefixes ?? [];
    const pathScore = getPathMatchScore(parsed.pathname, pathPrefixes);
    if (pathScore < 0) {
      continue;
    }

    const actionPrefix =
      routing.actionPrefix ??
      (routing.provider ? slugify(routing.provider) : inferProviderFromHostname(parsed.hostname));
    const provider = routing.provider ?? inferProviderFromHostname(parsed.hostname);
    const score = hostScore * 1_000 + pathScore;
    const matchedPathPrefix = getBestPathMatch(parsed.pathname, pathPrefixes);

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        credential,
        provider,
        actionPrefix,
        injection: routing.injection,
        matchedHost,
        matchedPathPrefix,
        score,
      };
    }
  }

  if (!bestMatch) {
    throw new NotFoundError(`No credential routing found for ${parsed.hostname}`);
  }

  const { score: _score, ...resolved } = bestMatch;
  return resolved;
}
