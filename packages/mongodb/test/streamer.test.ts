/**
 * Streamer Tests for MongoDB World
 */

import { streamerTests } from '@workflow-worlds/testing';
import { createStreamer } from './setup.js';

streamerTests({ createStreamer });
