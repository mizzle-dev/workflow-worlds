/**
 * Shared test setup for MongoDB World
 *
 * Manages MongoDB container lifecycle and provides factory functions.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { afterAll, beforeAll } from 'vitest';
import { MongoClient } from 'mongodb';

const __dirname = dirname(fileURLToPath(import.meta.url));

let container: Awaited<ReturnType<typeof MongoDBContainer.prototype.start>> | null = null;
let mongoClient: MongoClient | undefined;

beforeAll(async () => {
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

export const createStorage = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  const client = getMongoClient();
  await client.connect();

  const { storage } = await mod.createStorage({
    client,
    databaseName: 'test-extended',
  });
  return { storage };
};

export const createStreamer = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = getMongoClient();
  await client.connect();

  const { streamer } = await mod.createStreamer({
    client,
    databaseName: 'test-extended',
    useChangeStreams: false,
  });
  return { streamer };
};
