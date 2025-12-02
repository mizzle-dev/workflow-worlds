/**
 * Serialization Tests for Turso World
 */

import { serializationTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

serializationTests({ createStorage });
