/**
 * Serialization Tests for Redis World
 */

import { serializationTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

serializationTests({ createStorage });
