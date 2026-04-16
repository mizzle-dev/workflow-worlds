/**
 * CBOR-based queue transport utilities.
 *
 * Workflow SDK runs at spec version 3+ carry a `runInput` on the first queue
 * delivery whose `input` field is a `Uint8Array`. JSON serialization does not
 * round-trip `Uint8Array` values, so any world that wants to opt in to
 * `SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` must serialize queue payloads
 * with CBOR instead. BullMQ stores `job.data` as a JSON value, so we CBOR-encode
 * the payload to a base64 string before queueing and decode it in the worker
 * processor before POSTing to the workflow HTTP endpoint.
 *
 * Wire into `queue.ts`:
 * - On the send path, wrap `message` with `encodeForBullMq()` before passing it
 *   to `queue.add()`, and update the worker processor to run `decodeFromBullMq()`
 *   on `job.data` before forwarding it.
 * - On the HTTP send, serialize with `CborTransport` and set
 *   `content-type: application/cbor`.
 * - On `createQueueHandler`, use `DualTransport` to decode the request body
 *   (CBOR-first, JSON fallback during rollout).
 * - When `opts.specVersion < 3` is passed, keep using the JSON path so older
 *   runs continue to use the format they were created with.
 */

import type { Transport } from '@vercel/queue';
import { decode, encode } from 'cbor-x';

/** Prefix on base64 strings stored in BullMQ jobs to mark them as CBOR payloads. */
export const CBOR_BULLMQ_PREFIX = 'cbor:';

/**
 * Encode a payload for storage inside BullMQ `job.data`. Returns a discriminated
 * union so the worker can recognize CBOR payloads and decode them back to a
 * structured object before forwarding.
 */
export function encodeForBullMq(value: unknown): { __cbor: string } {
  const buffer = encode(value);
  return {
    __cbor: CBOR_BULLMQ_PREFIX + Buffer.from(buffer).toString('base64'),
  };
}

/**
 * Decode a payload written by {@link encodeForBullMq}. If the data is not a
 * CBOR-wrapped object (e.g., an older JSON payload from before the transition),
 * the value is returned unchanged.
 */
export function decodeFromBullMq<T = unknown>(data: unknown): T {
  if (
    data &&
    typeof data === 'object' &&
    '__cbor' in data &&
    typeof (data as { __cbor: unknown }).__cbor === 'string'
  ) {
    const encoded = (data as { __cbor: string }).__cbor;
    const body = encoded.startsWith(CBOR_BULLMQ_PREFIX)
      ? encoded.slice(CBOR_BULLMQ_PREFIX.length)
      : encoded;
    return decode(Buffer.from(body, 'base64')) as T;
  }
  return data as T;
}

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
