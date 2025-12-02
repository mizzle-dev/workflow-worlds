/**
 * Test Suite for MongoDB World
 *
 * This file runs both:
 * 1. The standard @workflow/world-testing suite (integration tests)
 * 2. Extended @workflow-worlds/testing suite (serialization, hooks, etc.)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { createTestSuite } from '@workflow/world-testing';
import {
  serializationTests,
  hookCleanupTests,
  streamerTests,
  outputPreservationTests,
} from '@workflow-worlds/testing';
import { afterAll, beforeAll } from 'vitest';
import { MongoClient } from 'mongodb';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

let container: Awaited<ReturnType<typeof MongoDBContainer.prototype.start>> | null = null;
let mongoClient: MongoClient | undefined;

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
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = undefined;
  }
  if (container) {
    console.log('Stopping MongoDB container...');
    await container.stop();
    console.log('MongoDB container stopped');
  }
});

// Helper to get or create MongoDB client
function getMongoClient(): MongoClient {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.WORKFLOW_MONGODB_URI!);
  }
  return mongoClient;
}

// =============================================================================
// Standard Test Suite
// =============================================================================
createTestSuite(worldPath);

// =============================================================================
// Extended Test Suite
// =============================================================================
// These tests verify data serialization, hook cleanup, and other edge cases.

// Create storage factory for extended tests
const createStorage = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  const client = getMongoClient();
  await client.connect();

  const { storage } = await mod.createStorage({
    client,
    databaseName: 'test-extended',
  });
  return { storage };
};

// Create streamer factory for extended tests
const createStreamer = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = getMongoClient();
  await client.connect();

  const { streamer } = await mod.createStreamer({
    client,
    databaseName: 'test-extended',
    useChangeStreams: false, // Disable change streams for simpler testing
  });
  return { streamer };
};

// Run extended tests
serializationTests({ createStorage });
hookCleanupTests({ createStorage });
streamerTests({ createStreamer });
outputPreservationTests({ createStorage });
