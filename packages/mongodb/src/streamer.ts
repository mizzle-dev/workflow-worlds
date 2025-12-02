/**
 * MongoDB Streamer Implementation
 *
 * This file implements the Streamer interface using MongoDB for storage
 * and change streams for real-time notifications.
 */

import { EventEmitter } from 'node:events';
import type { Streamer } from '@workflow/world';
import { MongoClient } from 'mongodb';
import { monotonicFactory } from 'ulid';
import { debug } from './utils.js';

const generateUlid = monotonicFactory();

/**
 * Represents a single chunk in a stream.
 */
interface StreamChunk {
  chunkId: string;
  streamName: string;
  data: Uint8Array;
  eof: boolean;
  createdAt: Date;
}

/**
 * Configuration for the streamer.
 */
export interface StreamerConfig {
  /**
   * MongoDB connection string.
   * If not provided, uses WORKFLOW_MONGODB_URI environment variable.
   * Default: 'mongodb://localhost:27017'
   */
  mongoUrl?: string;

  /**
   * Database name to use.
   * If not provided, uses WORKFLOW_MONGODB_DATABASE_NAME environment variable.
   * Default: 'workflow'
   */
  databaseName?: string;

  /**
   * Optional MongoDB client instance.
   * If provided, mongoUrl will be ignored.
   */
  client?: MongoClient;

  /**
   * Whether to use MongoDB Change Streams for real-time updates.
   * Default: true (falls back to polling if change streams not available)
   */
  useChangeStreams?: boolean;
}

/**
 * Creates the Streamer implementation using MongoDB.
 */
export async function createStreamer(config: StreamerConfig = {}): Promise<{
  streamer: Streamer;
  client: MongoClient;
  close: () => Promise<void>;
}> {
  // Get or create MongoDB client
  const client = config.client ?? new MongoClient(
    config.mongoUrl ?? process.env.WORKFLOW_MONGODB_URI ?? 'mongodb://localhost:27017'
  );

  // Connect if we created the client
  if (!config.client) {
    await client.connect();
  }

  const db = client.db(
    config.databaseName ?? process.env.WORKFLOW_MONGODB_DATABASE_NAME ?? 'workflow'
  );
  const chunksCollection = db.collection<StreamChunk>('stream_chunks');

  // Create indexes
  await chunksCollection.createIndex({ streamName: 1, chunkId: 1 });
  await chunksCollection.createIndex({ chunkId: 1 }, { unique: true });

  // Event emitter for real-time notifications
  // In a single-process deployment, this works fine
  // For multi-process, MongoDB change streams will handle distribution
  const emitter = new EventEmitter<{
    [key: `chunk:${string}`]: [StreamChunk];
    [key: `close:${string}`]: [];
  }>();
  emitter.setMaxListeners(100);

  // Set up MongoDB change stream for real-time updates (if enabled)
  const useChangeStreams = config.useChangeStreams !== false;
  let changeStream: any;
  let changeStreamDisabled = false;

  if (useChangeStreams) {
    try {
      changeStream = chunksCollection.watch([], { fullDocument: 'updateLookup' });

      changeStream.on('change', (change: any) => {
        if (change.operationType === 'insert' && change.fullDocument) {
          const chunk = change.fullDocument as StreamChunk;
          if (chunk.eof) {
            emitter.emit(`close:${chunk.streamName}`);
          } else {
            emitter.emit(`chunk:${chunk.streamName}`, chunk);
          }
        }
      });

      changeStream.on('error', async () => {
        // Only log once and disable change streams
        if (!changeStreamDisabled) {
          changeStreamDisabled = true;
          debug('Change streams not available (replica set required), using in-process events only');
          try {
            await changeStream.close();
          } catch {
            // Ignore close errors
          }
          changeStream = null;
        }
      });
    } catch {
      debug('Change streams not available, using in-process events only');
    }
  }

  const streamer: Streamer = {
    /**
     * Writes a chunk of data to a named stream.
     */
    async writeToStream(
      name: string,
      runId: string | Promise<string>,
      chunk: string | Uint8Array
    ): Promise<void> {
      // Await runId if it's a promise (ensures proper ordering)
      await runId;

      const chunkId = `chnk_${generateUlid()}`;

      // Convert to Uint8Array
      let data: Uint8Array;
      if (typeof chunk === 'string') {
        data = new TextEncoder().encode(chunk);
      } else {
        data = chunk;
      }

      const streamChunk: StreamChunk = {
        chunkId,
        streamName: name,
        data,
        eof: false,
        createdAt: new Date(),
      };

      // Store the chunk
      await chunksCollection.insertOne(streamChunk);

      // Emit real-time notification (for single-process)
      emitter.emit(`chunk:${name}`, streamChunk);
    },

    /**
     * Signals the end of a stream.
     */
    async closeStream(
      name: string,
      runId: string | Promise<string>
    ): Promise<void> {
      await runId;

      const chunkId = `chnk_${generateUlid()}`;
      const streamChunk: StreamChunk = {
        chunkId,
        streamName: name,
        data: new Uint8Array(0),
        eof: true,
        createdAt: new Date(),
      };

      // Store EOF marker
      await chunksCollection.insertOne(streamChunk);

      // Notify subscribers that stream is closed
      emitter.emit(`close:${name}`);
    },

    /**
     * Returns a ReadableStream for consuming stream data.
     */
    async readFromStream(
      name: string,
      startIndex = 0
    ): Promise<ReadableStream<Uint8Array>> {
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Track chunks we've already delivered to prevent duplicates
          const deliveredChunkIds = new Set<string>();

          // Buffer for chunks that arrive during initial load
          const bufferedEventChunks: StreamChunk[] = [];
          let isLoadingFromStorage = true;

          // Handler for new chunks (real-time)
          const chunkHandler = (chunk: StreamChunk) => {
            // Skip if already delivered
            if (deliveredChunkIds.has(chunk.chunkId)) {
              return;
            }
            deliveredChunkIds.add(chunk.chunkId);

            // Skip empty chunks (except EOF)
            if (chunk.data.byteLength === 0 && !chunk.eof) {
              return;
            }

            if (isLoadingFromStorage) {
              // Buffer chunks that arrive during initial load
              bufferedEventChunks.push(chunk);
            } else {
              // Deliver immediately after initial load
              if (chunk.data.byteLength > 0) {
                // Create a copy to prevent ArrayBuffer detachment
                controller.enqueue(Uint8Array.from(chunk.data));
              }
            }
          };

          // Handler for stream close
          const closeHandler = () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // Ignore if already closed
            }
          };

          // Cleanup function
          const cleanup = () => {
            emitter.off(`chunk:${name}`, chunkHandler);
            emitter.off(`close:${name}`, closeHandler);
          };

          // Subscribe to events FIRST (before loading from storage)
          emitter.on(`chunk:${name}`, chunkHandler);
          emitter.on(`close:${name}`, closeHandler);

          // Load existing chunks from storage
          const existingChunks = await chunksCollection
            .find({ streamName: name })
            .sort({ chunkId: 1 })
            .toArray();

          for (let i = startIndex; i < existingChunks.length; i++) {
            const chunk = existingChunks[i];

            // Check for EOF
            if (chunk.eof) {
              cleanup();
              controller.close();
              return;
            }

            // Skip if already delivered via event
            if (deliveredChunkIds.has(chunk.chunkId)) {
              continue;
            }
            deliveredChunkIds.add(chunk.chunkId);

            // Deliver the chunk
            if (chunk.data.byteLength > 0) {
              // Create a copy to prevent ArrayBuffer detachment
              controller.enqueue(Uint8Array.from(chunk.data));
            }
          }

          // Done loading from storage
          isLoadingFromStorage = false;

          // Deliver buffered event chunks in order
          bufferedEventChunks.sort((a, b) =>
            a.chunkId.localeCompare(b.chunkId)
          );

          for (const chunk of bufferedEventChunks) {
            if (chunk.eof) {
              cleanup();
              controller.close();
              return;
            }
            if (chunk.data.byteLength > 0) {
              controller.enqueue(Uint8Array.from(chunk.data));
            }
          }

          // Check if we already received EOF while loading
          const lastChunk = existingChunks[existingChunks.length - 1];
          if (lastChunk?.eof) {
            cleanup();
            controller.close();
          }
        },

        cancel() {
          // Clean up listeners when stream is cancelled
          emitter.removeAllListeners(`chunk:${name}`);
          emitter.removeAllListeners(`close:${name}`);
        },
      });
    },
  };

  return {
    streamer,
    client,
    close: async () => {
      if (changeStream) {
        await changeStream.close();
      }
      if (!config.client) {
        await client.close();
      }
    },
  };
}
