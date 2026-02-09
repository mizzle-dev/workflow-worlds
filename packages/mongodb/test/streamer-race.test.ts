import type { Streamer } from '@workflow/world';
import { beforeAll, describe, expect, test } from 'vitest';
import { createStreamer } from './setup.js';

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
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

  const bytes = new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
  return new TextDecoder().decode(bytes);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

describe('streamer race conditions', () => {
  let streamer: Streamer;

  beforeAll(async () => {
    ({ streamer } = await createStreamer());
  });

  test('does not drop chunk when close happens immediately after write', async () => {
    const expected = 'Hello from webhook!';
    const encoder = new TextEncoder();

    for (let i = 0; i < 50; i++) {
      const id = `${Date.now()}-${i}`;
      const streamName = `test-stream-race-${id}`;
      const runId = `wrun_test-${id}`;

      const readable = await streamer.readFromStream(streamName);
      const readPromise = withTimeout(readText(readable), 5000);

      await streamer.writeToStream(streamName, runId, encoder.encode(expected));
      await streamer.closeStream(streamName, runId);

      const result = await readPromise;
      expect(result).toBe(expected);
    }
  });
});
