/**
 * Streamer Tests for Redis World
 */

import { streamerTests } from '@workflow-worlds/testing';
import { createStreamer } from './setup.js';

streamerTests({ createStreamer });
