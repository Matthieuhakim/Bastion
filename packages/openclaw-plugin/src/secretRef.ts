import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import type { SecretValue } from './types.js';

/**
 * Resolves a SecretValue to a plain string at runtime.
 * Supports plain strings, $env, $file, and $exec sources.
 */
export async function resolveSecret(ref: SecretValue): Promise<string> {
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
    const stdout = execSync(ref.$exec, { encoding: 'utf8' });
    value = stdout.trim();
  }

  if (!value) {
    throw new Error('Resolved secret is empty');
  }

  return value;
}
