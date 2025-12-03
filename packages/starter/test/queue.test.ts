/**
 * Queue Tests for Starter World
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueTests } from '@workflow-worlds/testing';

const __dirname = dirname(fileURLToPath(import.meta.url));

const createQueue = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'queue.js'));
  const { queue } = mod.createQueue();
  return { queue };
};

queueTests({ createQueue });
