/**
 * CLI Setup Script for Turso World
 *
 * Runs database migrations to set up the schema.
 * Usage: pnpm exec workflow-turso-setup
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Sets up the database schema by running migrations.
 */
export async function setupDatabase(): Promise<void> {
  // Load .env file if it exists
  config();

  const databaseUrl =
    process.env.WORKFLOW_TURSO_DATABASE_URL ||
    process.env.TURSO_DATABASE_URL ||
    'file:workflow.db';

  const authToken =
    process.env.WORKFLOW_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;

  console.log('🔧 Setting up Turso database schema...');
  console.log(`📍 Database: ${databaseUrl}`);

  try {
    const client = createClient({
      url: databaseUrl,
      authToken,
    });

    const db = drizzle(client);

    // Enable WAL mode and busy timeout for local SQLite databases
    if (databaseUrl.startsWith('file:')) {
      await client.execute('PRAGMA journal_mode = WAL');
      await client.execute('PRAGMA busy_timeout = 5000');
    }

    // The migrations folder is in src/drizzle/migrations relative to the package root
    // When running from dist/, we need to go up one level to reach src/
    const migrationsFolder = join(__dirname, '..', 'src', 'drizzle', 'migrations');
    console.log(`📂 Running migrations from: ${migrationsFolder}`);

    await migrate(db, {
      migrationsFolder,
      migrationsTable: 'workflow_migrations',
    });

    console.log('✅ Database schema created successfully!');
    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to setup database:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase();
}
