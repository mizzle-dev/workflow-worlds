/**
 * Output Preservation Tests for Redis World
 */

import { outputPreservationTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

outputPreservationTests({ createStorage });
