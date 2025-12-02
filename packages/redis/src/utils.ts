/**
 * Redis Utility Functions
 *
 * Serialization helpers for converting between JavaScript objects and Redis Hash fields.
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor-x';

// CBOR prefix to distinguish from legacy JSON data
const CBOR_PREFIX = 'cbor:';

// =============================================================================
// Debug Logging
// =============================================================================

/**
 * Creates a debug logger that writes to stderr when enabled.
 *
 * Enable with WORKFLOW_DEBUG environment variable:
 * - WORKFLOW_DEBUG=1 or WORKFLOW_DEBUG=true - enables all debug output
 * - WORKFLOW_DEBUG=redis - enables only redis namespace
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
 * Debug logger for redis-world.
 * Enable with WORKFLOW_DEBUG=redis or WORKFLOW_DEBUG=1
 */
export const debug = createDebugLogger('redis-world');

// Fields that should be parsed as Date objects (top-level only)
const DATE_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'retryAfter',
  'scheduledFor',
  'lockedUntil',
]);

// Fields that should remain as strings even if they look like numbers
const STRING_FIELDS = new Set([
  'runId',
  'stepId',
  'eventId',
  'hookId',
  'token',
  'deploymentId',
  'workflowName',
  'stepName',
  'correlationId',
  'ownerId',
  'projectId',
  'environment',
  'status',
  'eventType',
]);

// =============================================================================
// CBOR Serialization
// =============================================================================

/**
 * Encodes a value using CBOR and returns a base64 string with prefix.
 * CBOR preserves Date, undefined, Map, Set, BigInt types automatically.
 */
export function toCbor(value: unknown): string {
  const buffer = cborEncode(value);
  return CBOR_PREFIX + Buffer.from(buffer).toString('base64');
}

/**
 * Decodes a CBOR-encoded string (with prefix) back to original value.
 * Returns undefined if the input is null/undefined.
 */
export function fromCbor<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!value.startsWith(CBOR_PREFIX)) {
    // Legacy JSON data - parse with JSON and hope for the best
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  const base64 = value.slice(CBOR_PREFIX.length);
  const buffer = Buffer.from(base64, 'base64');
  return cborDecode(buffer) as T;
}

/**
 * Serializes a JavaScript object for Redis Hash storage.
 * - Date objects are converted to ISO strings
 * - Objects/arrays are CBOR encoded (preserves nested Date types)
 * - undefined values are skipped
 * - null values are stored as empty string
 */
export function serializeForRedis(obj: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      result[key] = '';
      continue;
    }
    if (value instanceof Date) {
      result[key] = value.toISOString();
    } else if (typeof value === 'object') {
      // Use CBOR for objects - preserves Date, Map, Set, BigInt, undefined
      result[key] = toCbor(value);
    } else if (typeof value === 'boolean') {
      result[key] = value ? 'true' : 'false';
    } else {
      result[key] = String(value);
    }
  }

  return result;
}

/**
 * Deserializes Redis Hash fields back to a JavaScript object.
 * - CBOR-prefixed strings are decoded with full type preservation
 * - ISO date strings in known date fields are converted to Date objects
 * - Legacy JSON strings are parsed back to objects/arrays
 * - Empty strings become undefined
 * - Boolean strings are converted to booleans
 * - Numeric strings are converted to numbers (except for ID fields)
 */
export function deserializeFromRedis<T = Record<string, unknown>>(
  data: Record<string, string> | null
): T | null {
  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Empty string or 'undefined' becomes undefined
    if (value === '' || value === 'undefined') {
      result[key] = undefined;
      continue;
    }

    // CBOR-encoded objects (new format) - handles nested Dates automatically
    if (value.startsWith(CBOR_PREFIX)) {
      result[key] = fromCbor(value);
      continue;
    }

    // Date fields (top-level only)
    if (DATE_FIELDS.has(key)) {
      result[key] = new Date(value);
      continue;
    }

    // Boolean values
    if (value === 'true') {
      result[key] = true;
      continue;
    }
    if (value === 'false') {
      result[key] = false;
      continue;
    }

    // Legacy JSON objects/arrays (backwards compatibility)
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        result[key] = JSON.parse(value);
        continue;
      } catch {
        // Not valid JSON, treat as string
      }
    }

    // String fields (keep as string even if numeric)
    if (STRING_FIELDS.has(key)) {
      result[key] = value;
      continue;
    }

    // Numeric values (only simple decimal numbers, not hex/exponential/whitespace)
    const trimmed = value.trim();
    if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      result[key] = Number(trimmed);
      continue;
    }

    // Default: keep as string
    result[key] = value;
  }

  return result as T;
}

/**
 * Converts a ULID to a numeric score for sorted set operations.
 * ULIDs encode time in the first 10 characters (48-bit timestamp).
 */
export function ulidToScore(ulid: string): number {
  // Extract the timestamp portion (first 10 characters after prefix)
  // For our IDs like 'wrun_01HX...', we need to skip the prefix
  const ulidPart = ulid.includes('_') ? ulid.split('_')[1] : ulid;

  // ULID timestamp is encoded in base32 in first 10 chars
  // We can use string comparison for ordering since ULIDs are lexicographically sortable
  // For Redis sorted sets, we'll use the timestamp portion

  // Decode the first 10 characters (48-bit timestamp in Crockford Base32)
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let timestamp = 0;
  for (let i = 0; i < 10; i++) {
    const char = ulidPart[i].toUpperCase();
    const value = ENCODING.indexOf(char);
    if (value === -1) {
      // Fall back to current time if invalid
      return Date.now();
    }
    timestamp = timestamp * 32 + value;
  }

  return timestamp;
}

/**
 * Creates a key prefix function for consistent key naming.
 */
export function createKeyPrefix(prefix: string): (parts: string[]) => string {
  return (parts: string[]) => [prefix, ...parts].join(':');
}

/**
 * Deep clones an object using structuredClone.
 * Required because the workflow core may mutate returned objects.
 */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}
