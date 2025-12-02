/**
 * Output Preservation Tests for Turso World
 */

import { outputPreservationTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

outputPreservationTests({ createStorage });
