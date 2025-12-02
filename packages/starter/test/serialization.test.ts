/**
 * Serialization Tests for Starter World
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializationTests } from '@workflow-worlds/testing';

const __dirname = dirname(fileURLToPath(import.meta.url));

const createStorage = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  return { storage: mod.createStorage() };
};

serializationTests({ createStorage });
