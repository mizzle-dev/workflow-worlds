/**
 * Shared test setup for MongoDB World
 *
 * This file is loaded by vitest's setupFiles config.
 * It manages the MongoDB container lifecycle.
 *
 * If WORKFLOW_MONGODB_URI is already set (e.g., by GitHub Actions services),
 * testcontainers will be skipped.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';

const __dirname = dirname(fileURLToPath(import.meta.url));

let container: Awaited<ReturnType<typeof MongoDBContainer.prototype.start>> | null = null;
let mongoClient: MongoClient | undefined;

beforeAll(async () => {
  // Skip testcontainers if env var is already set (e.g., GitHub Actions services)
  if (process.env.WORKFLOW_MONGODB_URI) {
    console.log('Using existing MongoDB:', process.env.WORKFLOW_MONGODB_URI);
    return;
  }

  console.log('Starting MongoDB container...');
  container = await new MongoDBContainer('mongo:7').start();

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

function getMongoClient(): MongoClient {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.WORKFLOW_MONGODB_URI!);
  }
  return mongoClient;
}

export const worldPath = join(__dirname, '..', 'dist', 'index.js');

export async function createStorage() {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  const client = getMongoClient();
  await client.connect();

  const { storage } = await mod.createStorage({
    client,
    databaseName: 'test-extended',
  });
  return { storage };
}

export async function createStreamer() {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = getMongoClient();
  await client.connect();

  const { streamer } = await mod.createStreamer({
    client,
    databaseName: 'test-extended',
    useChangeStreams: false,
  });
  return { streamer };
}
