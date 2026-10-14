/**
 * Turso Streamer Implementation
 *
 * Implements the Streamer interface using Turso/libSQL for chunk storage
 * and EventEmitter for real-time notifications (single-process).
 */

import { EventEmitter } from 'node:events';
import type { Client, Row } from '@libsql/client';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { generateUlid } from './utils.js';


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
 */
export interface StreamerConfig {
  /**
   * Turso client instance.
   */
  client: Client;
}

/**
 * Converts a database row to a StreamChunk object.
 */
function rowToChunk(row: Row): StreamChunk {
  let data: Uint8Array;

  // Handle different data types from the database
  const rawData = row.data;
  if (rawData === null || rawData === undefined) {
    data = new Uint8Array(0);
  } else if (rawData instanceof ArrayBuffer) {
    data = new Uint8Array(rawData);
  } else if (ArrayBuffer.isView(rawData)) {
    data = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
  } else if (typeof rawData === 'string') {
    data = new TextEncoder().encode(rawData);
  } else {
    // Fallback for other types
    data = new Uint8Array(0);
  }

  return {
    chunkId: row.chunk_id as string,
    data,
    eof: (row.is_eof as number) === 1,
  };
}

/**
 * Creates the Streamer implementation using Turso/libSQL.
 */
export function createStreamer(config: StreamerConfig): Streamer {
  const { client } = config;

  // Event emitter for real-time notifications
  // For multi-process, use external pub/sub (Redis, etc.)
  const emitter = new EventEmitter<{
    [key: `chunk:${string}`]: [StreamChunk];
    [key: `close:${string}`]: [];
  }>();

  // Increase listener limit for high-concurrency scenarios
  emitter.setMaxListeners(100);

  async function registerStream(
    runId: string,
    streamName: string
  ): Promise<void> {
    await client.execute({
      sql: `INSERT OR IGNORE INTO stream_runs (run_id, stream_name, created_at)
            VALUES (?, ?, ?)`,
      args: [runId, streamName, new Date().toISOString()],
    });
  }

  function toBytes(chunk: string | Uint8Array): Uint8Array {
    return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
  }

  async function insertChunks(name: string, chunks: Uint8Array[]): Promise<void> {
    if (chunks.length === 0) return;
    const nowStr = new Date().toISOString();
    // Allocate every ID before writing so the batch keeps its order.
    const written = chunks.map((data) => ({ chunkId: `chnk_${generateUlid()}`, data }));
    await client.batch(
      written.map(({ chunkId, data }) => ({
        sql: `INSERT INTO stream_chunks (chunk_id, stream_name, data, is_eof, created_at)
              VALUES (?, ?, ?, 0, ?)`,
        args: [chunkId, name, data, nowStr],
      })),
      'write'
    );
    for (const { chunkId, data } of written) {
      emitter.emit(`chunk:${name}`, { chunkId, data, eof: false });
    }
  }

  /**
   * Data chunks only, in order, up to the first EOF marker. A producer that
   * retries its close can append rows after the first EOF; readers ignore them.
   */
  async function loadDataChunks(name: string): Promise<{ chunks: StreamChunk[]; done: boolean }> {
    const result = await client.execute({
      sql: `SELECT * FROM stream_chunks WHERE stream_name = ? ORDER BY chunk_id ASC`,
      args: [name],
    });
    const chunks: StreamChunk[] = [];
    for (const row of result.rows) {
      const chunk = rowToChunk(row);
      if (chunk.eof) return { chunks, done: true };
      chunks.push(chunk);
    }
    return { chunks, done: false };
  }

  const streams: Streamer['streams'] = {
    /**
     * Writes a chunk of data to a named stream.
     */
    async write(runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
      await registerStream(await runId, name);
      await insertChunks(name, [toBytes(chunk)]);
    },

    /**
     * Writes several chunks to a named stream in one batch.
     */
    async writeMulti(
      runId: string,
      name: string,
      chunks: (string | Uint8Array)[]
    ): Promise<void> {
      await registerStream(await runId, name);
      await insertChunks(name, chunks.map(toBytes));
    },

    /**
     * Signals the end of a stream.
     */
    async close(runId: string, name: string): Promise<void> {
      await registerStream(await runId, name);

      const chunkId = `chnk_${generateUlid()}`;
      const nowStr = new Date().toISOString();

      // Store EOF marker
      await client.execute({
        sql: `INSERT INTO stream_chunks (chunk_id, stream_name, data, is_eof, created_at)
              VALUES (?, ?, NULL, 1, ?)`,
        args: [chunkId, name, nowStr],
      });

      // Notify subscribers that stream is closed
      emitter.emit(`close:${name}`);
    },

    async list(runId: string): Promise<string[]> {
      const result = await client.execute({
        sql: `SELECT stream_name FROM stream_runs
              WHERE run_id = ?
              ORDER BY stream_name ASC`,
        args: [runId],
      });
      return result.rows.map((row) => row.stream_name as string);
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
        data: page.map((chunk, i) => ({ index: start + i, data: Uint8Array.from(chunk.data) })),
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

      // Store cleanup function so cancel() can access it
      let cleanup: (() => void) | null = null;

      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Track chunks we've already delivered to prevent duplicates
          const deliveredChunkIds = new Set<string>();

          // Buffer for chunks that arrive during initial load
          const bufferedEventChunks: StreamChunk[] = [];
          let isLoadingFromStorage = true;
          let closeRequested = false;

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
            if (isLoadingFromStorage) {
              // Don't close immediately during initial load. A close event can
              // race ahead of buffered chunk delivery.
              closeRequested = true;
              return;
            }
            cleanup?.();
            try {
              controller.close();
            } catch {
              // Ignore if already closed
            }
          };

          // Cleanup function - removes only this reader's handlers
          cleanup = () => {
            emitter.off(`chunk:${name}`, chunkHandler);
            emitter.off(`close:${name}`, closeHandler);
          };

          // Subscribe to events FIRST (before loading from storage)
          emitter.on(`chunk:${name}`, chunkHandler);
          emitter.on(`close:${name}`, closeHandler);

          // Load existing chunks from storage (async)
          (async () => {
            try {
              const result = await client.execute({
                sql: `SELECT * FROM stream_chunks
                      WHERE stream_name = ?
                      ORDER BY chunk_id ASC`,
                args: [name],
              });

              const existingChunks = result.rows.map(rowToChunk);

              for (let i = startIndex; i < existingChunks.length; i++) {
                const chunk = existingChunks[i];

                // Check for EOF
                if (chunk.eof) {
                  cleanup?.();
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
                  cleanup?.();
                  controller.close();
                  return;
                }
                if (chunk.data.byteLength > 0) {
                  controller.enqueue(Uint8Array.from(chunk.data));
                }
              }

              if (closeRequested) {
                cleanup?.();
                controller.close();
              }

            } catch (error) {
              cleanup?.();
              controller.error(error);
            }
          })();
        },

        cancel() {
          // Clean up only this reader's listeners when stream is cancelled
          cleanup?.();
        },
      });
    },
  };

  return { streams };
}
