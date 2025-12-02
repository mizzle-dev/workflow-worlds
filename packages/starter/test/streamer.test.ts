/**
 * Streamer Tests for Starter World
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamerTests } from '@workflow-worlds/testing';

const __dirname = dirname(fileURLToPath(import.meta.url));

const createStreamer = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  return { streamer: mod.createStreamer() };
};

streamerTests({ createStreamer });
