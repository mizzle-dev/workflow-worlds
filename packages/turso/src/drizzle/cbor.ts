/**
 * Custom CBOR Column Type for Drizzle ORM
 *
 * Provides type-preserving serialization for SQLite BLOB columns.
 * CBOR automatically preserves Date, undefined, Map, Set, BigInt types.
 */

import { customType } from 'drizzle-orm/sqlite-core';
import { encode, decode } from 'cbor-x';

/**
 * Creates a custom CBOR column type for Drizzle.
 * Stores data as BLOB with automatic CBOR encoding/decoding.
 * CBOR preserves Date, undefined, Map, Set, BigInt, and null types.
 *
 * @example
 * ```typescript
 * const table = sqliteTable('example', {
 *   data: Cbor<{ name: string; createdAt: Date }>()('data'),
 * });
 * ```
 */
export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'blob',
    fromDriver: (value): T => {
      // No data from database
      if (value === null || value === undefined) {
        return undefined as unknown as T;
      }
      // Empty buffer means undefined was stored
      const buf = value as Buffer;
      if (buf.length === 0) {
        return undefined as unknown as T;
      }
      // Decode CBOR - this preserves null, Date, etc.
      return decode(buf) as T;
    },
    toDriver: (value): Buffer => {
      // Only treat undefined as "no value" - null should be encoded
      if (value === undefined) {
        return Buffer.alloc(0);
      }
      // CBOR encodes null as a proper value (0xf6)
      return Buffer.from(encode(value));
    },
  });
}

/**
 * Helper type for schema definitions.
 * Marks specified keys as potentially CBOR-encoded (optional in the type).
 */
export type Cborized<T, K extends keyof T> = Omit<T, K> & {
  [P in K]?: T[P];
};
