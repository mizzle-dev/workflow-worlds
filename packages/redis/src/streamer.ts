/**
 * Redis Streamer Implementation
 *
 * This file implements the Streamer interface using Redis Streams and Pub/Sub:
 * - Redis Streams for persistent, ordered chunk storage
 * - Pub/Sub for real-time notifications to multiple consumers
 */

import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import type { Redis } from 'ioredis';
import { debug, generateUlid } from './utils.js';


/**
 * Configuration for the streamer.
 */
export interface StreamerConfig {
  /**
   * Key prefix for all Redis keys.
   * Default: 'workflow'
   */
  keyPrefix?: string;

  /**
   * Maximum length of Redis Streams (approximate, uses ~).
   * Default: 10000
   */
  streamMaxLen?: number;
}

/**
 * Creates the Streamer implementation using Redis Streams.
 */
export async function createStreamer(options: {
  redis: Redis;
  config?: StreamerConfig;
}): Promise<{ streamer: Streamer; close: () => Promise<void> }> {
  const { redis, config = {} } = options;
  const prefix = config.keyPrefix ?? 'workflow';
  const streamMaxLen = config.streamMaxLen ?? 10000;

  // Create a separate subscriber connection for pub/sub
  const subscriber = redis.duplicate();

  // Key helpers
  const keys = {
    stream: (name: string) => `${prefix}:stream:${name}`,
    closed: (name: string) => `${prefix}:stream:${name}:closed`,
    channel: (name: string) => `${prefix}:stream:channel:${name}`,
    runStreams: (runId: string) => `${prefix}:stream:runs:${runId}`,
  };

  function toBuffer(chunk: string | Uint8Array): Buffer {
    return typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk);
  }

  async function appendChunks(name: string, chunks: Buffer[]): Promise<void> {
    if (chunks.length === 0) return;
    const pipeline = redis.pipeline();
    const chunkIds = chunks.map(() => `chnk_${generateUlid()}`);
    chunks.forEach((data, i) => {
      // Add to Redis Stream with MAXLEN to prevent unbounded growth
      pipeline.xadd(
        keys.stream(name),
        'MAXLEN',
        '~',
        streamMaxLen,
        '*', // Auto-generate stream ID
        'chunkId',
        chunkIds[i],
        'data',
        data.toString('base64'),
        'eof',
        'false'
      );
    });
    for (const chunkId of chunkIds) {
      // Publish notification via Pub/Sub
      pipeline.publish(keys.channel(name), JSON.stringify({ type: 'chunk', chunkId }));
    }
    await pipeline.exec();
  }

  /** Data chunks up to the first EOF marker, in order. */
  async function loadDataChunks(name: string): Promise<{ chunks: Buffer[]; done: boolean }> {
    const entries = await redis.xrange(keys.stream(name), '-', '+');
    const chunks: Buffer[] = [];
    for (const [, fields] of entries) {
      const fieldMap = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap.set(fields[i], fields[i + 1]);
      }
      if (fieldMap.get('eof') === 'true') return { chunks, done: true };
      chunks.push(Buffer.from(fieldMap.get('data') ?? '', 'base64'));
    }
    return { chunks, done: false };
  }

  const streams: Streamer['streams'] = {
    /**
     * Writes a chunk of data to a named stream.
     */
    async write(runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
      // Await runId if it's a promise (ensures proper ordering)
      await redis.sadd(keys.runStreams(await runId), name);
      await appendChunks(name, [toBuffer(chunk)]);
    },

    /**
     * Writes several chunks to a named stream in one round trip.
     */
    async writeMulti(
      runId: string,
      name: string,
      chunks: (string | Uint8Array)[]
    ): Promise<void> {
      await redis.sadd(keys.runStreams(await runId), name);
      await appendChunks(name, chunks.map(toBuffer));
    },

    /**
     * Signals the end of a stream.
     */
    async close(runId: string, name: string): Promise<void> {
      await redis.sadd(keys.runStreams(await runId), name);

      const chunkId = `chnk_${generateUlid()}`;

      // Add EOF marker to stream
      await redis.xadd(
        keys.stream(name),
        '*',
        'chunkId',
        chunkId,
        'data',
        '',
        'eof',
        'true'
      );

      // Set closed flag
      await redis.set(keys.closed(name), '1');

      // Publish close notification
      await redis.publish(
        keys.channel(name),
        JSON.stringify({ type: 'close', chunkId })
      );
    },

    async list(runId: string): Promise<string[]> {
      return redis.smembers(keys.runStreams(runId));
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
        data: page.map((data, i) => ({ index: start + i, data: new Uint8Array(data) })),
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

      // Track cleanup state for this specific stream reader
      let streamCleanup: (() => void) | null = null;

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const streamKey = keys.stream(name);
          const channelKey = keys.channel(name);
          const closedKey = keys.closed(name);

          // Track chunks we've already delivered to prevent duplicates
          const deliveredChunkIds = new Set<string>();

          // Buffer for chunks that arrive during initial load
          const bufferedEventChunks: Array<{
            chunkId: string;
            data: Uint8Array;
            eof: boolean;
          }> = [];
          let isClosed = false;
          let closeSignalReceived = false;

          // Handler for pub/sub messages
          const messageHandler = (channel: string, message: string) => {
            if (channel !== channelKey) return;

            try {
              const parsed = JSON.parse(message);

              if (parsed.type === 'close') {
                // A close signal can race ahead of chunk polling. Delay closure
                // until we have drained persisted entries (including final chunk).
                closeSignalReceived = true;
              }
              // For chunk notifications, we'll poll for new data
            } catch {
              // Ignore invalid messages
            }
          };

          // Cleanup function
          const cleanup = () => {
            subscriber.off('message', messageHandler);
            subscriber.unsubscribe(channelKey).catch(() => {});
          };

          // Subscribe to notifications FIRST (before loading from storage)
          await subscriber.subscribe(channelKey);
          subscriber.on('message', messageHandler);

          // Check if stream is already closed
          const alreadyClosed = await redis.get(closedKey);
          if (alreadyClosed === '1') {
            // Load all existing chunks and close
            const allEntries = await redis.xrange(streamKey, '-', '+');

            let skipped = 0;
            for (const [, fields] of allEntries) {
              if (skipped < startIndex) {
                skipped++;
                continue;
              }

              const fieldMap = new Map<string, string>();
              for (let i = 0; i < fields.length; i += 2) {
                fieldMap.set(fields[i], fields[i + 1]);
              }

              const chunkId = fieldMap.get('chunkId') ?? '';
              const dataBase64 = fieldMap.get('data') ?? '';
              const eof = fieldMap.get('eof') === 'true';

              if (eof) {
                cleanup();
                controller.close();
                return;
              }

              if (deliveredChunkIds.has(chunkId)) continue;
              deliveredChunkIds.add(chunkId);

              if (dataBase64) {
                const data = Buffer.from(dataBase64, 'base64');
                if (data.length > 0) {
                  controller.enqueue(new Uint8Array(data));
                }
              }
            }

            cleanup();
            controller.close();
            return;
          }

          // Load existing chunks from storage
          const allEntries = await redis.xrange(streamKey, '-', '+');

          // Track the last stream ID we've seen for polling
          let lastStreamId = '0'; // Start from beginning if no entries

          let skipped = 0;
          for (const [streamId, fields] of allEntries) {
            lastStreamId = streamId; // Track the last seen stream ID

            if (skipped < startIndex) {
              skipped++;
              continue;
            }

            const fieldMap = new Map<string, string>();
            for (let i = 0; i < fields.length; i += 2) {
              fieldMap.set(fields[i], fields[i + 1]);
            }

            const chunkId = fieldMap.get('chunkId') ?? '';
            const dataBase64 = fieldMap.get('data') ?? '';
            const eof = fieldMap.get('eof') === 'true';

            if (eof) {
              cleanup();
              controller.close();
              return;
            }

            if (deliveredChunkIds.has(chunkId)) continue;
            deliveredChunkIds.add(chunkId);

            if (dataBase64) {
              const data = Buffer.from(dataBase64, 'base64');
              if (data.length > 0) {
                controller.enqueue(new Uint8Array(data));
              }
            }
          }

          // Deliver buffered chunks in order
          bufferedEventChunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));

          for (const chunk of bufferedEventChunks) {
            if (chunk.eof) {
              cleanup();
              controller.close();
              return;
            }
            if (chunk.data.length > 0) {
              controller.enqueue(chunk.data);
            }
          }

          // Start polling for new chunks using XREAD
          // Use the last seen stream ID to avoid missing entries added between
          // xrange and xread. Use '0' if no entries were loaded to get all.
          let lastId = lastStreamId;

          const pollInterval = setInterval(async () => {
            if (isClosed) {
              clearInterval(pollInterval);
              return;
            }

            try {
              // Check for new entries
              const newEntries = await redis.xread(
                'COUNT',
                100,
                'STREAMS',
                streamKey,
                lastId
              );

              if (!newEntries || newEntries.length === 0) {
                // Check if stream is now closed
                const nowClosed = await redis.get(closedKey);
                if ((closeSignalReceived || nowClosed === '1') && !isClosed) {
                  isClosed = true;
                  clearInterval(pollInterval);
                  cleanup();
                  try {
                    controller.close();
                  } catch {
                    // Ignore if already closed
                  }
                }
                return;
              }

              for (const [, entries] of newEntries) {
                for (const [streamId, fields] of entries) {
                  lastId = streamId;

                  const fieldMap = new Map<string, string>();
                  for (let i = 0; i < fields.length; i += 2) {
                    fieldMap.set(fields[i], fields[i + 1]);
                  }

                  const chunkId = fieldMap.get('chunkId') ?? '';
                  const dataBase64 = fieldMap.get('data') ?? '';
                  const eof = fieldMap.get('eof') === 'true';

                  if (deliveredChunkIds.has(chunkId)) continue;
                  deliveredChunkIds.add(chunkId);

                  if (eof) {
                    isClosed = true;
                    clearInterval(pollInterval);
                    cleanup();
                    try {
                      controller.close();
                    } catch {
                      // Ignore if already closed
                    }
                    return;
                  }

                  if (dataBase64) {
                    const data = Buffer.from(dataBase64, 'base64');
                    if (data.length > 0) {
                      try {
                        controller.enqueue(new Uint8Array(data));
                      } catch {
                        // Stream might be closed
                        clearInterval(pollInterval);
                        return;
                      }
                    }
                  }
                }
              }
            } catch (err) {
              debug('Stream poll error:', err);
            }
          }, 100); // Poll every 100ms

          // Store cleanup function for cancel()
          streamCleanup = () => {
            clearInterval(pollInterval);
            cleanup();
          };
        },

        cancel() {
          // Clean up on cancellation
          if (streamCleanup) {
            streamCleanup();
            streamCleanup = null;
          }
        },
      });
    },
  };

  /**
   * Closes the subscriber connection.
   * Should be called when the streamer is no longer needed.
   */
  async function close(): Promise<void> {
    await subscriber.quit();
  }

  return { streamer: { streams }, close };
}
