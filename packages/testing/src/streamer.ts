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

        await streamer.streams.write(runId, streamName, new TextEncoder().encode(testData));
        await streamer.streams.close(runId, streamName);

        const readableStream = await streamer.streams.get(runId, streamName);
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

        await streamer.streams.write(runId, streamName, binaryData);
        await streamer.streams.close(runId, streamName);

        const readableStream = await streamer.streams.get(runId, streamName);
        const chunks = await readAllChunks(readableStream);

        const result = new Uint8Array(chunks.flatMap((c) => Array.from(c)));
        expect(Array.from(result)).toEqual(Array.from(binaryData));
      });

      test('handles null bytes in stream data', async () => {
        const streamName = `test-stream-null-${Date.now()}`;
        const runId = `wrun_test-${Date.now()}`;
        const dataWithNull = new TextEncoder().encode('before\0after');

        await streamer.streams.write(runId, streamName, dataWithNull);
        await streamer.streams.close(runId, streamName);

        const readableStream = await streamer.streams.get(runId, streamName);
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
          await streamer.streams.write(runId, streamName, new TextEncoder().encode(msg + '\n'));
        }
        await streamer.streams.close(runId, streamName);

        const readableStream = await streamer.streams.get(runId, streamName);
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

        await streamer.streams.write(runId, stream1, new TextEncoder().encode('stream 1 data'));
        await streamer.streams.write(runId, stream2, new TextEncoder().encode('stream 2 data'));
        await streamer.streams.close(runId, stream1);
        await streamer.streams.close(runId, stream2);

        // Read stream 1
        const readable1 = await streamer.streams.get(runId, stream1);
        const chunks1 = await readAllChunks(readable1);
        const result1 = new TextDecoder().decode(
          new Uint8Array(chunks1.flatMap((c) => Array.from(c)))
        );

        // Read stream 2
        const readable2 = await streamer.streams.get(runId, stream2);
        const chunks2 = await readAllChunks(readable2);
        const result2 = new TextDecoder().decode(
          new Uint8Array(chunks2.flatMap((c) => Array.from(c)))
        );

        expect(result1).toBe('stream 1 data');
        expect(result2).toBe('stream 2 data');
      });

      test('lists stream names by runId', async () => {
        const baseId = Date.now();
        const runId = `wrun_test-${baseId}`;
        const otherRunId = `wrun_test-${baseId}-other`;
        const stream1 = `test-list-1-${baseId}`;
        const stream2 = `test-list-2-${baseId}`;
        const otherStream = `test-list-other-${baseId}`;

        await streamer.streams.write(runId, stream1, new TextEncoder().encode('a'));
        await streamer.streams.write(runId, stream1, new TextEncoder().encode('b'));
        await streamer.streams.write(runId, stream2, new TextEncoder().encode('c'));
        await streamer.streams.write(otherRunId, otherStream, new TextEncoder().encode('d'));
        await streamer.streams.close(runId, stream1);
        await streamer.streams.close(runId, stream2);
        await streamer.streams.close(otherRunId, otherStream);

        const runStreams = await streamer.streams.list(runId);
        const runStreamSet = new Set(runStreams);

        expect(runStreamSet.has(stream1)).toBe(true);
        expect(runStreamSet.has(stream2)).toBe(true);
        expect(runStreamSet.has(otherStream)).toBe(false);

        const stream1Count = runStreams.filter((name) => name === stream1).length;
        expect(stream1Count).toBe(1);

        const unknownRunStreams = await streamer.streams.list(`missing-${baseId}`);
        expect(Array.isArray(unknownRunStreams)).toBe(true);
        expect(unknownRunStreams).toHaveLength(0);
      });
    });

    describe('chunk pagination and tail reads', () => {
      test('pages chunks and reports the tail', async () => {
        const baseId = Date.now();
        const runId = `wrun_test-${baseId}`;
        const streamName = `test-chunks-${baseId}`;
        const encoder = new TextEncoder();

        for (const part of ['a', 'b', 'c']) {
          await streamer.streams.write(runId, streamName, encoder.encode(part));
        }

        const open = await streamer.streams.getInfo(runId, streamName);
        expect(open).toEqual({ tailIndex: 2, done: false });

        await streamer.streams.close(runId, streamName);

        const first = await streamer.streams.getChunks(runId, streamName, { limit: 2 });
        expect(first.data.map((c) => c.index)).toEqual([0, 1]);
        expect(first.hasMore).toBe(true);
        expect(first.done).toBe(true);

        const rest = await streamer.streams.getChunks(runId, streamName, {
          limit: 2,
          cursor: first.cursor!,
        });
        expect(rest.data.map((c) => new TextDecoder().decode(c.data))).toEqual(['c']);
        expect(rest.data[0].index).toBe(2);
        expect(rest.hasMore).toBe(false);

        const closed = await streamer.streams.getInfo(runId, streamName);
        expect(closed).toEqual({ tailIndex: 2, done: true });
      });

      test('reads from a negative start index relative to the end', async () => {
        const baseId = Date.now();
        const runId = `wrun_test-${baseId}`;
        const streamName = `test-tail-${baseId}`;
        const encoder = new TextEncoder();

        if (streamer.streams.writeMulti) {
          await streamer.streams.writeMulti(runId, streamName, ['1', '2', '3', '4'].map((x) => encoder.encode(x)));
        } else {
          for (const part of ['1', '2', '3', '4']) {
            await streamer.streams.write(runId, streamName, encoder.encode(part));
          }
        }
        await streamer.streams.close(runId, streamName);

        const chunks = await readAllChunks(await streamer.streams.get(runId, streamName, -2));
        const result = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => Array.from(c))));
        expect(result).toBe('34');
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

        await streamer.streams.write(runId, streamName,
          new TextEncoder().encode(JSON.stringify(jsonData))
        );
        await streamer.streams.close(runId, streamName);

        const readableStream = await streamer.streams.get(runId, streamName);
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
