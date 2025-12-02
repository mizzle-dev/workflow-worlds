/**
 * Streamer Test Suite
 *
 * Tests stream functionality including:
 * - Binary data writing/reading
 * - Named streams
 * - Stream closure
 * - Data preservation through streaming
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Streamer } from '@workflow/world';

export interface StreamerTestOptions {
  /**
   * Factory function to create a streamer instance.
   */
  createStreamer: () => Promise<{ streamer: Streamer; cleanup?: () => Promise<void> }>;
}

/**
 * Helper to read all chunks from a ReadableStream
 */
async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

/**
 * Creates the streamer test suite.
 * Tests binary data, named streams, and stream lifecycle.
 */
export function streamerTests(options: StreamerTestOptions) {
  describe('streamer', () => {
    let streamer: Streamer;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const result = await options.createStreamer();
      streamer = result.streamer;
      cleanup = result.cleanup;
    });

    afterAll(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    describe('basic streaming', () => {
      test('writes and reads text data', async () => {
        const streamName = `test-stream-text-${Date.now()}`;
        const runId = `wrun_test-${Date.now()}`;
        const testData = 'Hello, World!';

        await streamer.writeToStream(streamName, runId, new TextEncoder().encode(testData));
        await streamer.closeStream(streamName, runId);

        const readableStream = await streamer.readFromStream(streamName);
        const chunks = await readAllChunks(readableStream);

        const result = new TextDecoder().decode(
          new Uint8Array(chunks.flatMap((c) => Array.from(c)))
        );
        expect(result).toBe(testData);
      });

      test('writes and reads binary data', async () => {
        const streamName = `test-stream-binary-${Date.now()}`;
        const runId = `wrun_test-${Date.now()}`;
        const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

        await streamer.writeToStream(streamName, runId, binaryData);
        await streamer.closeStream(streamName, runId);

        const readableStream = await streamer.readFromStream(streamName);
        const chunks = await readAllChunks(readableStream);

        const result = new Uint8Array(chunks.flatMap((c) => Array.from(c)));
        expect(Array.from(result)).toEqual(Array.from(binaryData));
      });

      test('handles null bytes in stream data', async () => {
        const streamName = `test-stream-null-${Date.now()}`;
        const runId = `wrun_test-${Date.now()}`;
        const dataWithNull = new TextEncoder().encode('before\0after');

        await streamer.writeToStream(streamName, runId, dataWithNull);
        await streamer.closeStream(streamName, runId);

        const readableStream = await streamer.readFromStream(streamName);
        const chunks = await readAllChunks(readableStream);

        const result = new TextDecoder().decode(
          new Uint8Array(chunks.flatMap((c) => Array.from(c)))
        );
        expect(result).toBe('before\0after');
      });
    });

    describe('multiple writes', () => {
      test('preserves order of multiple writes', async () => {
        const streamName = `test-stream-order-${Date.now()}`;
        const runId = `wrun_test-${Date.now()}`;
        const messages = ['first', 'second', 'third'];

        for (const msg of messages) {
          await streamer.writeToStream(streamName, runId, new TextEncoder().encode(msg + '\n'));
        }
        await streamer.closeStream(streamName, runId);

        const readableStream = await streamer.readFromStream(streamName);
        const chunks = await readAllChunks(readableStream);

        const result = new TextDecoder().decode(
          new Uint8Array(chunks.flatMap((c) => Array.from(c)))
        );
        expect(result).toBe('first\nsecond\nthird\n');
      });
    });

    describe('named streams', () => {
      test('maintains separate named streams', async () => {
        const baseId = Date.now();
        const runId = `wrun_test-${baseId}`;
        const stream1 = `test-named-1-${baseId}`;
        const stream2 = `test-named-2-${baseId}`;

        await streamer.writeToStream(stream1, runId, new TextEncoder().encode('stream 1 data'));
        await streamer.writeToStream(stream2, runId, new TextEncoder().encode('stream 2 data'));
        await streamer.closeStream(stream1, runId);
        await streamer.closeStream(stream2, runId);

        // Read stream 1
        const readable1 = await streamer.readFromStream(stream1);
        const chunks1 = await readAllChunks(readable1);
        const result1 = new TextDecoder().decode(
          new Uint8Array(chunks1.flatMap((c) => Array.from(c)))
        );

        // Read stream 2
        const readable2 = await streamer.readFromStream(stream2);
        const chunks2 = await readAllChunks(readable2);
        const result2 = new TextDecoder().decode(
          new Uint8Array(chunks2.flatMap((c) => Array.from(c)))
        );

        expect(result1).toBe('stream 1 data');
        expect(result2).toBe('stream 2 data');
      });
    });

    describe('JSON data in streams', () => {
      test('preserves JSON structure through stream', async () => {
        const streamName = `test-stream-json-${Date.now()}`;
        const runId = `wrun_test-${Date.now()}`;
        const jsonData = {
          string: 'test',
          number: 42,
          boolean: true,
          array: [1, 2, 3],
          nested: { deep: 'value' },
        };

        await streamer.writeToStream(
          streamName,
          runId,
          new TextEncoder().encode(JSON.stringify(jsonData))
        );
        await streamer.closeStream(streamName, runId);

        const readableStream = await streamer.readFromStream(streamName);
        const chunks = await readAllChunks(readableStream);

        const result = new TextDecoder().decode(
          new Uint8Array(chunks.flatMap((c) => Array.from(c)))
        );
        const parsed = JSON.parse(result);

        expect(parsed).toEqual(jsonData);
      });
    });
  });
}
