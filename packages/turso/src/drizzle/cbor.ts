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
      // Drizzle handles null at a higher level for optional columns
      // This is only called when there's actual data
      if (value === null || value === undefined) {
        return undefined as unknown as T;
      }
      return decode(value as Buffer) as T;
    },
    toDriver: (value): Buffer => {
      // Drizzle handles null at a higher level for optional columns
      // Return empty buffer for null/undefined (shouldn't normally happen)
      if (value === undefined || value === null) {
        return Buffer.alloc(0);
      }
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
