/**
 * Test Suite for MongoDB World
 *
 * Uses @testcontainers/mongodb to automatically manage MongoDB container lifecycle.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll } from 'vitest';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

let container: Awaited<ReturnType<typeof MongoDBContainer.prototype.start>> | null = null;

beforeAll(async () => {
  // Start MongoDB container using testcontainers
  console.log('Starting MongoDB container...');
  container = await new MongoDBContainer('mongo:7').start();

  // Set connection URI for the world to use
  const connectionString = container.getConnectionString() + '?directConnection=true';
  console.log('MongoDB container started:', connectionString);

  process.env.WORKFLOW_MONGODB_URI = connectionString;
}, 120_000);

afterAll(async () => {
  if (container) {
    console.log('Stopping MongoDB container...');
    await container.stop();
    console.log('MongoDB container stopped');
  }
});

// Run the full test suite against the MongoDB world
createTestSuite(worldPath);
