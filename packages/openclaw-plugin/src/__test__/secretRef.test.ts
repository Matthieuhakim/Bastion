import { describe, it, expect, vi, afterEach } from 'vitest';

// Hoist mocks before any imports that use these modules
vi.mock('fs', () => ({ readFileSync: vi.fn() }));
vi.mock('child_process', () => ({ execSync: vi.fn() }));

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolveSecret } from '../secretRef.js';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExecSync = vi.mocked(execSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveSecret', () => {
  it('returns plain string directly', async () => {
    const result = await resolveSecret('my-secret');
    expect(result).toBe('my-secret');
  });

  it('throws if plain string is empty', async () => {
    await expect(resolveSecret('')).rejects.toThrow('Resolved secret is empty');
  });

  it('$env reads from process.env', async () => {
    process.env['TEST_SECRET_VAR'] = 'env-value';
    const result = await resolveSecret({ $env: 'TEST_SECRET_VAR' });
    expect(result).toBe('env-value');
    delete process.env['TEST_SECRET_VAR'];
  });

  it('$env throws if variable is not set', async () => {
    delete process.env['MISSING_VAR'];
    await expect(resolveSecret({ $env: 'MISSING_VAR' })).rejects.toThrow(
      'Environment variable "MISSING_VAR" is not set or empty',
    );
  });

  it('$env throws if variable is empty string', async () => {
    process.env['EMPTY_VAR'] = '';
    await expect(resolveSecret({ $env: 'EMPTY_VAR' })).rejects.toThrow(
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
    await expect(resolveSecret({ $file: '/path/to/empty' })).rejects.toThrow(
      'Resolved secret is empty',
    );
  });

  it('$exec executes command and trims stdout', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecSync as any).mockReturnValue('  exec-secret  \n');
    const result = await resolveSecret({ $exec: 'echo exec-secret' });
    expect(result).toBe('exec-secret');
    expect(mockExecSync).toHaveBeenCalledWith('echo exec-secret', { encoding: 'utf8' });
  });

  it('$exec throws if stdout is empty after trim', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecSync as any).mockReturnValue('   ');
    await expect(resolveSecret({ $exec: 'true' })).rejects.toThrow('Resolved secret is empty');
  });
});
