/**
 * MongoDB Streamer Implementation
 *
 * This file implements the Streamer interface using MongoDB for storage
 * and change streams for real-time notifications.
 */

import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { MongoClient } from 'mongodb';
import { debug, generateUlid } from './utils.js';


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

interface StreamRun {
  runId: string;
  streamName: string;
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
  const streamRunsCollection = db.collection<StreamRun>('stream_runs');

  // Create indexes
  await Promise.all([
    chunksCollection.createIndex({ streamName: 1, chunkId: 1 }),
    chunksCollection.createIndex({ chunkId: 1 }, { unique: true }),
    streamRunsCollection.createIndex({ runId: 1 }),
    streamRunsCollection.createIndex({ runId: 1, streamName: 1 }, { unique: true }),
  ]);

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

  async function registerStream(runId: string, streamName: string): Promise<void> {
    await streamRunsCollection.updateOne(
      { runId, streamName },
      {
        $setOnInsert: {
          runId,
          streamName,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  /** Chunk data as bytes, whether it came back as BSON Binary or a Buffer. */
  function chunkBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data && typeof (data as { value?: unknown }).value === 'function') {
      return new Uint8Array((data as { value: () => Uint8Array }).value());
    }
    return new Uint8Array((data as { buffer?: ArrayBuffer })?.buffer ?? new ArrayBuffer(0));
  }

  async function insertChunks(name: string, chunks: (string | Uint8Array)[]): Promise<void> {
    if (chunks.length === 0) return;
    // Allocate every ID before writing so the batch keeps its order.
    const docs: StreamChunk[] = chunks.map((chunk) => ({
      chunkId: `chnk_${generateUlid()}`,
      streamName: name,
      data: typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
      eof: false,
      createdAt: new Date(),
    }));
    await chunksCollection.insertMany(docs.map((doc) => ({ ...doc })), { ordered: true });
    // Emit real-time notification (for single-process)
    for (const doc of docs) emitter.emit(`chunk:${name}`, doc);
  }

  /** Data chunks up to the first EOF marker, in order. */
  async function loadDataChunks(name: string): Promise<{ chunks: Uint8Array[]; done: boolean }> {
    const docs = await chunksCollection.find({ streamName: name }).sort({ chunkId: 1 }).toArray();
    const chunks: Uint8Array[] = [];
    for (const doc of docs) {
      if (doc.eof) return { chunks, done: true };
      chunks.push(chunkBytes(doc.data));
    }
    return { chunks, done: false };
  }

  const streams: Streamer['streams'] = {
    /**
     * Writes a chunk of data to a named stream.
     */
    async write(runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
      // Await runId if it's a promise (ensures proper ordering)
      await registerStream(await runId, name);
      await insertChunks(name, [chunk]);
    },

    /**
     * Writes several chunks to a named stream in one insert.
     */
    async writeMulti(
      runId: string,
      name: string,
      chunks: (string | Uint8Array)[]
    ): Promise<void> {
      await registerStream(await runId, name);
      await insertChunks(name, chunks);
    },

    /**
     * Signals the end of a stream.
     */
    async close(runId: string, name: string): Promise<void> {
      await registerStream(await runId, name);

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

    async list(runId: string): Promise<string[]> {
      const streamRuns = await streamRunsCollection
        .find({ runId })
        .sort({ streamName: 1 })
        .toArray();
      return streamRuns.map((streamRun) => streamRun.streamName);
    },

    async getChunks(
      _runId: string,
      name: string,
      options?: GetChunksOptions
    ): Promise<StreamChunksResponse> {
      const limit = options?.limit ?? 100;
      const start = options?.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
      const { chunks, done } = await loadDataChunks(name);
      const page = chunks.slice(start, start + limit);
      const hasMore = start + page.length < chunks.length;
      return {
        data: page.map((data, i) => ({ index: start + i, data })),
        cursor: hasMore ? String(start + page.length) : null,
        hasMore,
        done,
      };
    },

    async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
      const { chunks, done } = await loadDataChunks(name);
      return { tailIndex: chunks.length - 1, done };
    },

    /**
     * Returns a ReadableStream for consuming stream data.
     */
    async get(
      _runId: string,
      name: string,
      requestedStartIndex = 0
    ): Promise<ReadableStream<Uint8Array>> {
      // A negative start counts back from the current end of the stream.
      let startIndex = requestedStartIndex;
      if (startIndex < 0) {
        const { chunks } = await loadDataChunks(name);
        startIndex = Math.max(0, chunks.length + startIndex);
      }

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Track chunks we've already delivered to prevent duplicates
          const deliveredChunkIds = new Set<string>();

          // Buffer for chunks that arrive during initial load
          const bufferedEventChunks: StreamChunk[] = [];
          let isLoadingFromStorage = true;
          let closeRequested = false;
          let isClosed = false;

          // Helper to convert MongoDB Binary to Uint8Array
          const toUint8Array = (data: Uint8Array | unknown): Uint8Array => {
            if (data instanceof Uint8Array) return data;
            return new Uint8Array((data as any).buffer || data);
          };

          const closeController = () => {
            if (isClosed) {
              return;
            }
            isClosed = true;
            cleanup();
            try {
              controller.close();
            } catch {
              // Ignore if already closed
            }
          };

          // Handler for new chunks (real-time)
          const chunkHandler = (chunk: StreamChunk) => {
            if (isClosed) {
              return;
            }
            // Skip if already delivered
            if (deliveredChunkIds.has(chunk.chunkId)) {
              return;
            }
            deliveredChunkIds.add(chunk.chunkId);

            // Convert MongoDB Binary to Uint8Array if needed
            const data = toUint8Array(chunk.data);

            // Skip empty chunks (except EOF)
            if (data.byteLength === 0 && !chunk.eof) {
              return;
            }

            if (isLoadingFromStorage) {
              // Buffer chunks that arrive during initial load
              bufferedEventChunks.push(chunk);
            } else {
              // Deliver immediately after initial load
              if (data.byteLength > 0) {
                // Create a copy to prevent ArrayBuffer detachment
                controller.enqueue(Uint8Array.from(data));
              }
            }
          };

          // Handler for stream close
          const closeHandler = () => {
            // If close arrives while we're still loading persisted chunks,
            // defer closure until we flush buffered data.
            if (isLoadingFromStorage) {
              closeRequested = true;
              return;
            }
            closeController();
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
              closeController();
              return;
            }

            // Skip if already delivered via event
            if (deliveredChunkIds.has(chunk.chunkId)) {
              continue;
            }
            deliveredChunkIds.add(chunk.chunkId);

            // Convert MongoDB Binary to Uint8Array if needed
            const data = toUint8Array(chunk.data);

            // Deliver the chunk
            if (data.byteLength > 0) {
              // Create a copy to prevent ArrayBuffer detachment
              controller.enqueue(Uint8Array.from(data));
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
              closeController();
              return;
            }
            const data = toUint8Array(chunk.data);
            if (data.byteLength > 0) {
              controller.enqueue(Uint8Array.from(data));
            }
          }

          // Check if we already received EOF while loading
          const lastChunk = existingChunks[existingChunks.length - 1];
          if (closeRequested || lastChunk?.eof) {
            closeController();
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
    streamer: { streams },
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
