/**
 * CBOR-based queue transport utilities.
 *
 * Workflow SDK runs at spec version 3+ carry a `runInput` on the first queue
 * delivery whose `input` field is a `Uint8Array`. JSON serialization does not
 * round-trip `Uint8Array` values, so any world that wants to opt in to
 * `SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` must serialize queue payloads
 * with CBOR instead.
 *
 * These classes mirror the pattern used in `@workflow/world-vercel`:
 * - `CborTransport` always encodes/decodes CBOR (for new outgoing messages).
 * - `DualTransport` decodes CBOR first and falls back to JSON, so handlers keep
 *   accepting any JSON-encoded messages that were in-flight when the transport
 *   was switched over.
 *
 * Wire them into `queue.ts` by replacing `new JsonTransport()` with
 * `new CborTransport()` for the encode path and `new DualTransport()` for the
 * HTTP handler decode path. When `opts.specVersion < 3` is passed to `queue()`,
 * fall back to JSON so older runs continue to use the format they were
 * created with.
 */

import type { Transport } from '@vercel/queue';
import { decode, encode } from 'cbor-x';

export class CborTransport implements Transport<unknown> {
  readonly contentType = 'application/cbor';

  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return decode(Buffer.concat(chunks));
  }
}

/**
 * Dual-mode decoder: try CBOR first, fall back to JSON if that fails.
 * Use this on the receive side while the sender is still transitioning, or to
 * keep compatibility with JSON-encoded messages that were already queued.
 */
export class DualTransport implements Transport<unknown> {
  readonly contentType = 'application/cbor';

  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value));
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    try {
      return decode(buffer);
    } catch {
      return JSON.parse(buffer.toString('utf8'));
    }
  }
}
