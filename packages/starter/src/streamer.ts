/**
 * In-Memory Streamer Implementation
 *
 * This file implements the Streamer interface using in-memory arrays and EventEmitter.
 * Replace with your actual streaming backend (Redis Streams, Kafka, database, etc.).
 *
 * TODO markers indicate where to swap in your real backend.
 */

import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

const generateUlid = monotonicFactory();

/**
 * Represents a single chunk in a stream.
 */
interface StreamChunk {
  chunkId: string;
  data: Uint8Array;
  eof: boolean;
}

/**
 * Configuration for the streamer.
 *
 * TODO: Add your streaming-specific configuration options.
 */
export interface StreamerConfig {
  // Add configuration options for your streaming backend
}

/**
 * Creates the Streamer implementation.
 *
 * TODO: Replace the in-memory storage with your streaming backend.
 */
export function createStreamer(_config: StreamerConfig = {}): Streamer {
  // In-memory storage for stream chunks
  // TODO: Replace with your database/storage
  const streams = new Map<string, StreamChunk[]>();

  /** Data chunks up to the first EOF marker, in order. */
  function dataChunks(name: string): { chunks: StreamChunk[]; done: boolean } {
    const all = streams.get(name) ?? [];
    const eof = all.findIndex((chunk) => chunk.eof);
    return eof === -1 ? { chunks: all, done: false } : { chunks: all.slice(0, eof), done: true };
  }
  const streamNamesByRun = new Map<string, Set<string>>();

  // Event emitter for real-time notifications
  // TODO: For multi-process, use pub/sub (Redis, PostgreSQL LISTEN/NOTIFY, etc.)
  const emitter = new EventEmitter<{
    [key: `chunk:${string}`]: [StreamChunk];
    [key: `close:${string}`]: [];
  }>();

  // Increase listener limit for high-concurrency scenarios
  emitter.setMaxListeners(100);

  function registerStream(runId: string, streamName: string): void {
    let streamNames = streamNamesByRun.get(runId);
    if (!streamNames) {
      streamNames = new Set<string>();
      streamNamesByRun.set(runId, streamNames);
    }
    streamNames.add(streamName);
  }

  const api: Streamer['streams'] = {
    /**
     * Writes a chunk of data to a named stream.
     *
     * TODO: Replace with your storage backend:
     * - Redis: XADD stream * data chunk
     * - PostgreSQL: INSERT INTO stream_chunks + NOTIFY
     * - MongoDB: Insert document + Change Streams
     */
    async write(
      runId: string,
      name: string,
      chunk: string | Uint8Array
    ): Promise<void> {
      // Await runId if it's a promise (ensures proper ordering)
      const resolvedRunId = await runId;
      registerStream(resolvedRunId, name);

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
        data,
        eof: false,
      };

      // Store the chunk
      // TODO: INSERT INTO stream_chunks VALUES (...)
      if (!streams.has(name)) {
        streams.set(name, []);
      }
      streams.get(name)!.push(streamChunk);

      // Emit real-time notification
      // TODO: Publish to your pub/sub system
      emitter.emit(`chunk:${name}`, streamChunk);
    },

    /**
     * Signals the end of a stream.
     *
     * TODO: Store EOF marker and notify subscribers.
     */
    async close(runId: string, name: string): Promise<void> {
      const resolvedRunId = await runId;
      registerStream(resolvedRunId, name);

      const chunkId = `chnk_${generateUlid()}`;
      const streamChunk: StreamChunk = {
        chunkId,
        data: new Uint8Array(0),
        eof: true,
      };

      // Store EOF marker
      // TODO: INSERT INTO stream_chunks VALUES (..., eof = true)
      if (!streams.has(name)) {
        streams.set(name, []);
      }
      streams.get(name)!.push(streamChunk);

      // Notify subscribers that stream is closed
      // TODO: Publish close event to your pub/sub system
      emitter.emit(`close:${name}`);
    },

    async writeMulti(
      runId: string,
      name: string,
      chunks: (string | Uint8Array)[]
    ): Promise<void> {
      for (const chunk of chunks) {
        await api.write(runId, name, chunk);
      }
    },

    async getChunks(
      _runId: string,
      name: string,
      options?: GetChunksOptions
    ): Promise<StreamChunksResponse> {
      const limit = options?.limit ?? 100;
      const start = options?.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
      const { chunks, done } = dataChunks(name);
      const page = chunks.slice(start, start + limit);
      const hasMore = start + page.length < chunks.length;
      return {
        data: page.map((chunk, i) => ({ index: start + i, data: Uint8Array.from(chunk.data) })),
        cursor: hasMore ? String(start + page.length) : null,
        hasMore,
        done,
      };
    },

    async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
      const { chunks, done } = dataChunks(name);
      return { tailIndex: chunks.length - 1, done };
    },

    async list(runId: string): Promise<string[]> {
      return Array.from(streamNamesByRun.get(runId) ?? []);
    },

    /**
     * Returns a ReadableStream for consuming stream data.
     *
     * This implementation:
     * 1. Loads existing chunks from storage
     * 2. Subscribes to real-time notifications for new chunks
     * 3. Deduplicates chunks that arrive via both mechanisms
     * 4. Closes when EOF is received
     *
     * TODO: Replace with your streaming backend's read mechanism.
     */
    async get(
      _runId: string,
      name: string,
      requestedStartIndex = 0
    ): Promise<ReadableStream<Uint8Array>> {
      // A negative start counts back from the current end of the stream.
      const startIndex =
        requestedStartIndex < 0
          ? Math.max(0, dataChunks(name).chunks.length + requestedStartIndex)
          : requestedStartIndex;
      return new ReadableStream<Uint8Array>({
        start(controller) {
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
          // This ensures we don't miss chunks that arrive during loading
          emitter.on(`chunk:${name}`, chunkHandler);
          emitter.on(`close:${name}`, closeHandler);

          // Load existing chunks from storage
          // TODO: SELECT * FROM stream_chunks WHERE stream_name = ? ORDER BY chunk_id
          const existingChunks = streams.get(name) ?? [];

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

  return { streams: api };
}
