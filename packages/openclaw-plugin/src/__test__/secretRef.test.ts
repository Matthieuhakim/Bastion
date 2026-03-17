import { describe, it, expect, vi, afterEach } from 'vitest';

// Hoist mocks before any imports that use these modules
vi.mock('fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'fs';
import { resolveSecret } from '../secretRef.js';

const mockReadFileSync = vi.mocked(readFileSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveSecret', () => {
  it('returns plain string directly', async () => {
    const result = await resolveSecret('my-secret');
    expect(result).toBe('my-secret');
  });

  it('throws if plain string is empty', async () => {
    expect(() => resolveSecret('')).toThrow('Resolved secret is empty');
  });

  it('$env reads from process.env', async () => {
    process.env['TEST_SECRET_VAR'] = 'env-value';
    const result = await resolveSecret({ $env: 'TEST_SECRET_VAR' });
    expect(result).toBe('env-value');
    delete process.env['TEST_SECRET_VAR'];
  });

  it('$env throws if variable is not set', async () => {
    delete process.env['MISSING_VAR'];
    expect(() => resolveSecret({ $env: 'MISSING_VAR' })).toThrow(
      'Environment variable "MISSING_VAR" is not set or empty',
    );
  });

  it('$env throws if variable is empty string', async () => {
    process.env['EMPTY_VAR'] = '';
    expect(() => resolveSecret({ $env: 'EMPTY_VAR' })).toThrow(
      'Environment variable "EMPTY_VAR" is not set or empty',
    );
    delete process.env['EMPTY_VAR'];
  });

  it('$file reads and trims file contents', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFileSync as any).mockReturnValue('  file-secret  \n');
    const result = await resolveSecret({ $file: '/path/to/secret' });
    expect(result).toBe('file-secret');
    expect(mockReadFileSync).toHaveBeenCalledWith('/path/to/secret', 'utf8');
  });

  it('$file throws if file content is empty after trim', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFileSync as any).mockReturnValue('   ');
    expect(() => resolveSecret({ $file: '/path/to/empty' })).toThrow('Resolved secret is empty');
  });
});
