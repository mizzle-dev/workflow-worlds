/**
 * MongoDB World Utility Functions
 */

import { globalSingleton } from '@workflow/utils';
import { monotonicFactory } from 'ulid';

// =============================================================================
// Debug Logging
// =============================================================================

/**
 * Creates a debug logger that writes to stderr when enabled.
 *
 * Enable with WORKFLOW_DEBUG environment variable:
 * - WORKFLOW_DEBUG=1 or WORKFLOW_DEBUG=true - enables all debug output
 * - WORKFLOW_DEBUG=mongodb - enables only mongodb namespace
 * - WORKFLOW_DEBUG=redis,mongodb - enables multiple namespaces
 *
 * Writes to stderr to avoid interfering with CLI stdout JSON parsing.
 */
function createDebugLogger(namespace: string) {
  return (...args: unknown[]) => {
    const debug = process.env.WORKFLOW_DEBUG;
    if (!debug) return;

    // Check if debugging is enabled for this namespace
    const enabled =
      debug === '1' ||
      debug === 'true' ||
      debug === '*' ||
      debug.split(',').some((ns) => ns.trim() === namespace);

    if (!enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${namespace}]`;

    // Format message parts
    const message = args
      .map((arg) =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(' ');

    // Write to stderr to avoid interfering with stdout JSON parsing
    process.stderr.write(`${prefix} ${message}\n`);
  };
}

/**
 * Debug logger for mongodb-world.
 * Enable with WORKFLOW_DEBUG=mongodb or WORKFLOW_DEBUG=1
 */
export const debug = createDebugLogger('mongodb-world');

// =============================================================================
// Queue Message Encoding
// =============================================================================

/**
 * Queue messages are JSON, at rest and on the HTTP hop to the handler, with
 * `Uint8Array` values (a step dispatch carries its input as one) encoded as
 * `{ __type: 'Uint8Array', data: '<base64>' }`. Plain JSON would turn them
 * into objects of numbered keys. This is the same encoding the Local World's
 * queue uses.
 */
export function stringifyQueueMessage(message: unknown): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    value instanceof Uint8Array
      ? { __type: 'Uint8Array', data: Buffer.from(value).toString('base64') }
      : value
  );
}

export function parseQueueMessage(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { __type?: unknown }).__type === 'Uint8Array' &&
      typeof (value as { data?: unknown }).data === 'string'
    ) {
      return new Uint8Array(Buffer.from((value as { data: string }).data, 'base64'));
    }
    return value;
  });
}

// =============================================================================
// ID Generation
// =============================================================================

/**
 * One monotonic ULID factory per process, shared by every copy of this module
 * a bundler produces. Stream chunks are ordered by their ID, so two copies
 * with their own factories could order chunks written in the same
 * millisecond by chance.
 */
const ids = globalSingleton('@workflow-worlds/mongodb//ulid', 1, () => ({
  next: monotonicFactory(),
}));

export function generateUlid(): string {
  return ids.next();
}
