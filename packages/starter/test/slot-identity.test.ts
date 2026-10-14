/**
 * Slot Identity Tests for Starter World
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotIdentityTests } from '@workflow-worlds/testing';

const __dirname = dirname(fileURLToPath(import.meta.url));

const createStorage = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  return { storage: mod.createStorage() };
};

slotIdentityTests({ createStorage });
