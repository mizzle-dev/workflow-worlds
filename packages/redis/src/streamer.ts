/**
 * Redis Streamer Implementation
 *
 * This file implements the Streamer interface using Redis Streams and Pub/Sub:
 * - Redis Streams for persistent, ordered chunk storage
 * - Pub/Sub for real-time notifications to multiple consumers
 */

import type { Streamer } from '@workflow/world';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';

const generateUlid = monotonicFactory();

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
      const resolvedRunId = await runId;
      await redis.sadd(keys.runStreams(resolvedRunId), name);

      const chunkId = `chnk_${generateUlid()}`;

      // Convert to Buffer for Redis
      let data: Buffer;
      if (typeof chunk === 'string') {
        data = Buffer.from(chunk, 'utf-8');
      } else {
        data = Buffer.from(chunk);
      }

      // Add to Redis Stream with MAXLEN to prevent unbounded growth
      await redis.xadd(
        keys.stream(name),
        'MAXLEN',
        '~',
        streamMaxLen,
        '*', // Auto-generate stream ID
        'chunkId',
        chunkId,
        'data',
        data.toString('base64'),
        'eof',
        'false'
      );

      // Publish notification via Pub/Sub
      await redis.publish(
        keys.channel(name),
        JSON.stringify({ type: 'chunk', chunkId })
      );
    },

    /**
     * Signals the end of a stream.
     */
    async closeStream(
      name: string,
      runId: string | Promise<string>
    ): Promise<void> {
      const resolvedRunId = await runId;
      await redis.sadd(keys.runStreams(resolvedRunId), name);

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

    async listStreamsByRunId(runId: string): Promise<string[]> {
      return redis.smembers(keys.runStreams(runId));
    },

    /**
     * Returns a ReadableStream for consuming stream data.
     */
    async readFromStream(
      name: string,
      startIndex = 0
    ): Promise<ReadableStream<Uint8Array>> {
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

          // Handler for pub/sub messages
          const messageHandler = (channel: string, message: string) => {
            if (channel !== channelKey) return;

            try {
              const parsed = JSON.parse(message);

              if (parsed.type === 'close') {
                if (!isClosed) {
                  isClosed = true;
                  cleanup();
                  try {
                    controller.close();
                  } catch {
                    // Ignore if already closed
                  }
                }
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
                if (nowClosed === '1' && !isClosed) {
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
              console.error('[redis-world] Stream poll error:', err);
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

  return { streamer, close };
}
