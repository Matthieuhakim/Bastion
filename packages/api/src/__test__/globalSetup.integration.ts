import { execSync } from 'node:child_process';

export async function setup() {
  const testDbUrl = 'postgresql://bastion:bastion@localhost:5432/bastion_test';

  // Create test database if it doesn't exist
  try {
    execSync(
      `psql "postgresql://bastion:bastion@localhost:5432/bastion" -c "CREATE DATABASE bastion_test"`,
      { stdio: 'pipe' },
    );
  } catch {
    // Database already exists
  }

  // Apply migrations to test database
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: testDbUrl },
    cwd: new URL('../..', import.meta.url).pathname,
  });
}
