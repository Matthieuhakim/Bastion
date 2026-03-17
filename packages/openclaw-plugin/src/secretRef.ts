import { readFileSync } from 'fs';
import type { SecretValue } from './types.js';

/**
 * Resolves a SecretValue to a plain string at runtime.
 * Supports plain strings, $env, and $file sources.
 */
export function resolveSecret(ref: SecretValue): string {
  let value: string;

  if (typeof ref === 'string') {
    value = ref;
  } else if ('$env' in ref) {
    const envValue = process.env[ref.$env];
    if (!envValue) {
      throw new Error(`Environment variable "${ref.$env}" is not set or empty`);
    }
    value = envValue;
  } else if ('$file' in ref) {
    const contents = readFileSync(ref.$file, 'utf8');
    value = contents.trim();
  } else {
    throw new Error('Unsupported secret reference');
  }

  if (!value) {
    throw new Error('Resolved secret is empty');
  }

  return value;
}
